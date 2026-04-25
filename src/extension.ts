import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface LlmRequestConfig {
	base_url: string;
	api_key: string;
	model: string;
	provider: ProviderType;
}

interface WorkflowArgs {
	problem: string;
	test_text: string;
	test_mode: TestMode;
}

interface BackendSessionRequest extends WorkflowArgs {
	llm: LlmRequestConfig;
	context_enabled: boolean;
	max_rounds: number;
	resolved_test_code?: string;
}

interface BackendSessionState {
	session_id: string;
	problem_statement: string;
	test_text: string;
	test_mode: TestMode;
	context_enabled: boolean;
	max_rounds: number;
	status: string;
	current_stage: string;
	current_code: string;
	current_plan: string;
	resolved_test_code: string;
	latest_evaluation?: WorkflowResult;
	passed: boolean;
	attempt_count: number;
	regeneration_count: number;
	events: BackendEvent[];
	context_entries: Array<Record<string, unknown>>;
	created_at: string;
	updated_at: string;
	available_actions: string[];
}

interface BackendEvent {
	id: string;
	stage: string;
	status: string;
	title: string;
	message: string;
	data?: Record<string, unknown>;
	created_at: string;
}

interface BackendActionResult {
	stage?: string;
	message?: string;
	passed?: boolean;
	interrupted?: boolean;
	[key: string]: unknown;
}

interface BackendResponse {
	ok: boolean;
	session?: BackendSessionState;
	sessions?: BackendSessionState[];
	stage_result?: BackendActionResult;
	detail?: string;
}

type WorkflowResult = {
	passed?: boolean;
	code?: string;
	[key: string]: unknown;
};

type BridgeLogLevel = 'runtime' | 'stdout' | 'stderr' | 'info' | 'error';

interface RunRequest {
	problem: string;
	testText: string;
	testMode: TestMode;
	contextEnabled: boolean;
	maxRounds: number;
	executionMode: 'auto' | 'continue';
	resolvedTestCode?: string;
}

type InteractionState = 'idle' | 'await_plan' | 'await_failure_choice' | 'done';

interface ActionRequestState {
	problem?: string;
	testText?: string;
	testMode?: TestMode;
	useErrorFeedback: boolean;
	contextEnabled?: boolean;
	maxRounds?: number;
	planOverride?: string;
	executionMode?: 'auto' | 'continue';
	resolvedTestCode?: string;
}

type ResumeState =
	| { kind: 'interactive-initial-evaluate'; request: RunRequest }
	| { kind: 'interactive-plan-evaluate'; request: ActionRequestState }
	| { kind: 'interactive-restart-evaluate'; request: ActionRequestState }
	| { kind: 'auto'; request: RunRequest };

type ProviderType = 'openai' | 'claude' | 'other' | 'ollama' | 'vllm';
type TestMode = 'manual' | 'generate';

interface ProfileMeta {
	id: string;
	name: string;
	baseUrl: string;
	model: string;
	provider: ProviderType;
}

interface Profile extends ProfileMeta {
	apiKey: string;
}

interface ProfileFileData {
	version: 1;
	activeProfileId: string;
	profiles: Profile[];
}

const EXTENSION_ID = 'adaassist';
const LEGACY_EXTENSION_ID = 'adacoder';
const EXTENSION_DISPLAY_NAME = 'AdaAssist';
const LEGACY_API_KEY_SECRET = `${LEGACY_EXTENSION_ID}.apiKey`;
const PROFILE_FILE_VERSION = 1;
const DEFAULT_PROFILE_CONFIG_RELATIVE_PATH = '.vscode/adaassist-profiles.json';
const LEGACY_PROFILE_CONFIG_RELATIVE_PATH = '.vscode/adacoder-profiles.json';
const DEFAULT_BACKEND_ENTRY_RELATIVE_PATH = 'backend/main.py';
const DEFAULT_BACKEND_HOST = '127.0.0.1';
const DEFAULT_BACKEND_PORT = 8765;

class BackendServerManager {
	private process: ChildProcess | undefined;
	private startPromise: Promise<void> | undefined;

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel
	) {}

	public async request<T extends BackendResponse>(pathName: string, init?: RequestInit): Promise<T> {
		const response = await this.fetch(pathName, init);
		const payload = await response.json() as T;
		if (!response.ok || !payload.ok) {
			const detail = typeof payload.detail === 'string' && payload.detail.trim()
				? payload.detail.trim()
				: `Backend request failed with status ${response.status}.`;
			throw new Error(detail);
		}
		return payload;
	}

	public async fetch(pathName: string, init?: RequestInit, allowRestart = true): Promise<Response> {
		await this.ensureStarted();
		const baseUrl = this.getBaseUrl();

		try {
			return await fetch(new URL(pathName, baseUrl), {
				...init,
				headers: {
					'content-type': 'application/json',
					...(init?.headers ?? {})
				}
			});
		} catch (error) {
			if (!allowRestart) {
				throw error;
			}
			this.outputChannel.appendLine(`[backend] request failed, restarting server: ${String(error)}`);
			await this.restart();
			return this.fetch(pathName, init, false);
		}
	}

	public async ensureStarted(): Promise<void> {
		if (await this.isHealthy()) {
			return;
		}

		if (this.startPromise) {
			await this.startPromise;
			return;
		}

		this.startPromise = this.startServer();
		try {
			await this.startPromise;
		} finally {
			this.startPromise = undefined;
		}
	}

	public async restart(): Promise<void> {
		this.stop();
		await this.ensureStarted();
	}

	public stop(): void {
		if (this.process && !this.process.killed) {
			this.process.kill();
		}
		this.process = undefined;
		this.startPromise = undefined;
	}

	private getBaseUrl(): string {
		const host = getConfigurationValue<string>('backendHost', DEFAULT_BACKEND_HOST) || DEFAULT_BACKEND_HOST;
		const port = getConfigurationValue<number>('backendPort', DEFAULT_BACKEND_PORT) || DEFAULT_BACKEND_PORT;
		return `http://${host}:${port}/`;
	}

	private async startServer(): Promise<void> {
		const backendPath = resolveBackendEntryPath(this.context);
		if (!fs.existsSync(backendPath)) {
			throw new Error(`Backend entry not found: ${backendPath}`);
		}

		const pythonPath = resolvePythonPath(this.context);
		const host = getConfigurationValue<string>('backendHost', DEFAULT_BACKEND_HOST) || DEFAULT_BACKEND_HOST;
		const port = getConfigurationValue<number>('backendPort', DEFAULT_BACKEND_PORT) || DEFAULT_BACKEND_PORT;
		this.outputChannel.appendLine(`[backend] python=${pythonPath}`);
		this.outputChannel.appendLine(`[backend] entry=${backendPath}`);
		this.outputChannel.appendLine(`[backend] listen=${host}:${port}`);

		const process = spawn(
			pythonPath,
			[backendPath, '--host', host, '--port', String(port)],
			{
				cwd: path.dirname(backendPath),
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		this.process = process;

		process.stdout?.on('data', (buffer: Buffer) => {
			const text = buffer.toString().trim();
			if (text) {
				this.outputChannel.appendLine(`[backend stdout] ${text}`);
			}
		});

		process.stderr?.on('data', (buffer: Buffer) => {
			const text = buffer.toString().trim();
			if (text) {
				this.outputChannel.appendLine(`[backend stderr] ${text}`);
			}
		});

		process.on('exit', (code, signal) => {
			this.outputChannel.appendLine(`[backend exit] code=${code ?? 'null'} signal=${signal ?? 'null'}`);
			this.process = undefined;
		});

		for (let attempt = 0; attempt < 40; attempt += 1) {
			if (await this.isHealthy()) {
				this.outputChannel.appendLine('[backend] server is ready');
				return;
			}
			await delay(250);
		}

		throw new Error('Timed out waiting for FastAPI backend to become ready.');
	}

	private async isHealthy(): Promise<boolean> {
		try {
			const response = await fetch(new URL('/health', this.getBaseUrl()));
			if (!response.ok) {
				return false;
			}
			const payload = await response.json() as { ok?: boolean };
			return Boolean(payload.ok);
		} catch {
			return false;
		}
	}
}

class AdacoderChatPanel implements vscode.WebviewViewProvider {
	public static readonly viewType = `${EXTENSION_ID}.sidebarView`;
	private static readonly containerCommand = `workbench.view.extension.${EXTENSION_ID}-sidebar`;
	public static currentPanel: AdacoderChatPanel | undefined;

	private readonly providerDisposable: vscode.Disposable;
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly viewDisposables: vscode.Disposable[] = [];
	private readonly backendServer: BackendServerManager;
	private running = false;
	private interruptRequested = false;
	private pollingSession = false;
	private sessionPollHandle: ReturnType<typeof setInterval> | undefined;
	private lastSessionSnapshot = '';
	private profiles: Profile[] = [];
	private activeProfileId = '';
	private preferredPage: 'task' | 'settings' = 'task';
	private pendingProblem = '';
	private pendingTestText = '';
	private activeSession: BackendSessionState | undefined;
	private workflowMode: RunRequest['executionMode'] = 'auto';
	private interactiveState: InteractionState = 'idle';
	private resumeState: ResumeState | undefined;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel
	) {
		this.backendServer = new BackendServerManager(context, outputChannel);
		this.providerDisposable = vscode.window.registerWebviewViewProvider(AdacoderChatPanel.viewType, this, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		});
		this.context.subscriptions.push(this.providerDisposable);
	}

	public static async createOrShow(
		context: vscode.ExtensionContext,
		outputChannel: vscode.OutputChannel
	): Promise<AdacoderChatPanel> {
		if (AdacoderChatPanel.currentPanel) {
			return AdacoderChatPanel.currentPanel;
		}

		AdacoderChatPanel.currentPanel = new AdacoderChatPanel(context, outputChannel);
		await AdacoderChatPanel.currentPanel.initialize(context);
		return AdacoderChatPanel.currentPanel;
	}

	public async reveal(): Promise<void> {
		await vscode.commands.executeCommand(AdacoderChatPanel.containerCommand);
		try {
			await vscode.commands.executeCommand(`${AdacoderChatPanel.viewType}.focus`);
		} catch {
			// Ignore focus command failures on older VS Code versions.
		}
	}

	public disposeRuntime(): void {
		this.stopSessionPolling();
		this.backendServer.stop();
	}

	public showTaskPage(): void {
		this.preferredPage = 'task';
		this.postMessage({ type: 'switchPage', page: 'task' });
	}

	public showSettingsPage(): void {
		this.preferredPage = 'settings';
		this.postMessage({ type: 'switchPage', page: 'settings' });
	}

	public prefillProblem(problem: string): void {
		this.pendingProblem = problem;
		this.postMessage({
			type: 'prefillProblem',
			problem
		});
	}

	public setTestText(testText: string): void {
		this.pendingTestText = testText;
		this.postMessage({
			type: 'prefillTestText',
			testText
		});
	}

	public async runWorkflow(context: vscode.ExtensionContext, request: RunRequest): Promise<void> {
		await this.executeWorkflow(context, request);
	}

	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
		};
		webviewView.webview.html = getChatHtml(webviewView.webview, this.context.extensionUri);

		this.clearViewDisposables();
		webviewView.webview.onDidReceiveMessage((message: unknown) => {
			void this.handleMessage(this.context, message);
		}, null, this.viewDisposables);

		webviewView.onDidDispose(() => {
			this.view = undefined;
			this.clearViewDisposables();
		}, null, this.viewDisposables);

		await this.postState();
		this.postMessage({ type: 'switchPage', page: this.preferredPage });
		if (this.pendingProblem) {
			this.postMessage({ type: 'prefillProblem', problem: this.pendingProblem });
		}
		if (this.pendingTestText) {
			this.postMessage({ type: 'prefillTestText', testText: this.pendingTestText });
		}
	}

	private async initialize(context: vscode.ExtensionContext): Promise<void> {
		await this.loadProfiles(context);
	}

	private clearViewDisposables(): void {
		while (this.viewDisposables.length > 0) {
			const disposable = this.viewDisposables.pop();
			disposable?.dispose();
		}
	}

	private postMessage(message: Record<string, unknown>): void {
		if (!this.view) {
			return;
		}
		void this.view.webview.postMessage(message);
	}

	private async postState(): Promise<void> {
		this.postMessage({
			type: 'state',
			profiles: this.profiles,
			activeProfileId: this.activeProfileId,
			session: this.activeSession,
			workflowMode: this.workflowMode,
			interactiveState: this.interactiveState,
			canResume: Boolean(this.resumeState),
			resumeLabel: this.resumeLabel(),
			interruptRequested: this.interruptRequested
		});
	}

	private resumeLabel(): string {
		if (!this.resumeState) {
			return '';
		}
		switch (this.resumeState.kind) {
			case 'interactive-initial-evaluate':
				return 'Resume to run the current code against the tests.';
			case 'interactive-plan-evaluate':
				return 'Resume to evaluate the latest code regenerated from the plan.';
			case 'interactive-restart-evaluate':
				return 'Resume to evaluate the restarted attempt.';
			case 'auto':
				return 'Resume the auto workflow from the current progress.';
			default:
				return '';
		}
	}

	private clearResumeState(): void {
		this.resumeState = undefined;
	}

	private sessionSnapshot(session: BackendSessionState | undefined): string {
		if (!session) {
			return '';
		}
		return [
			session.session_id,
			session.updated_at,
			String(session.events.length),
			session.current_stage,
			session.status,
			String(session.resolved_test_code.length),
			String(session.current_code.length),
			String(session.current_plan.length)
		].join(':');
	}

	private startSessionPolling(): void {
		if (this.sessionPollHandle) {
			return;
		}
		this.lastSessionSnapshot = this.sessionSnapshot(this.activeSession);
		this.sessionPollHandle = setInterval(() => {
			void this.refreshActiveSession();
		}, 450);
	}

	private stopSessionPolling(): void {
		if (this.sessionPollHandle) {
			clearInterval(this.sessionPollHandle);
			this.sessionPollHandle = undefined;
		}
		this.pollingSession = false;
	}

	private async refreshActiveSession(force = false): Promise<void> {
		if (!this.activeSession?.session_id || this.pollingSession) {
			return;
		}

		this.pollingSession = true;
		try {
			const currentSessionId = this.activeSession.session_id;
			const payload = await this.backendServer.request<BackendResponse>(`/api/sessions/${currentSessionId}`);
			const session = payload.session;
			if (!session || session.session_id !== currentSessionId) {
				return;
			}

			const snapshot = this.sessionSnapshot(session);
			const changed = force || snapshot !== this.lastSessionSnapshot;
			this.activeSession = session;
			this.lastSessionSnapshot = snapshot;

			if (changed) {
				await this.postState();
				this.postSessionState();
			}
		} catch {
			// Ignore transient polling failures while a workflow action is running.
		} finally {
			this.pollingSession = false;
		}
	}

	private getActiveProfile(): Profile | undefined {
		return this.profiles.find((profile) => profile.id === this.activeProfileId);
	}

	private async handleMessage(context: vscode.ExtensionContext, message: unknown): Promise<void> {
		if (!isRecord(message) || typeof message.type !== 'string') {
			return;
		}

		try {
			switch (message.type) {
				case 'ready': {
					await this.loadProfiles(context);
					await this.postState();
					break;
				}
					case 'switchProfile': {
					const profileId = typeof message.profileId === 'string' ? message.profileId : '';
					if (!profileId) {
						break;
					}
					const exists = this.profiles.some((profile) => profile.id === profileId);
					if (!exists) {
						break;
					}
					this.activeProfileId = profileId;
					await this.persistProfiles(context);
					await this.postState();
					break;
					}
					case 'saveProfile': {
						await this.saveProfile(context, message);
						break;
					}
					case 'deleteProfile': {
						await this.deleteProfile(context, message);
						break;
					}
					case 'runWorkflow': {
						const problem = typeof message.problem === 'string' ? message.problem : '';
						const testText = typeof message.testText === 'string' ? message.testText : '';
						const testMode: TestMode = message.testMode === 'generate' ? 'generate' : 'manual';
						const contextEnabled = typeof message.contextEnabled === 'boolean' ? message.contextEnabled : false;
						const maxRounds = typeof message.maxRounds === 'number' ? message.maxRounds : 10;
						const executionMode = message.executionMode === 'continue' ? 'continue' : 'auto';
						const resolvedTestCode = typeof message.resolvedTestCode === 'string' ? message.resolvedTestCode : undefined;
						await this.executeWorkflow(context, { problem, testText, testMode, contextEnabled, maxRounds, executionMode, resolvedTestCode });
						break;
					}
				case 'interruptWorkflow': {
					await this.interruptWorkflow();
					break;
				}
				case 'resumeWorkflow': {
					await this.resumeWorkflow(context);
					break;
				}
				case 'continueWithPlan': {
					const request = this.parseActionRequest(message);
					await this.continueWithPlan(context, request);
					break;
				}
				case 'continueWithFeedback': {
					const request = this.parseActionRequest(message);
					await this.continueWithFeedback(context, request);
					break;
				}
				case 'restartInteractiveWorkflow': {
					const request = this.parseActionRequest(message);
					await this.restartInteractiveWorkflow(context, request);
					break;
				}
				case 'stopInteractiveWorkflow': {
					await this.stopInteractiveWorkflow();
					break;
				}
				case 'runWorkflowAction': {
					const action = typeof message.action === 'string' ? message.action : '';
					await this.runWorkflowAction(context, {
						...this.parseActionRequest(message),
						action
					});
					break;
				}
				case 'updateWorkflowPlan': {
					const plan = typeof message.plan === 'string' ? message.plan : '';
					await this.updateWorkflowPlan(context, plan);
					break;
				}
				case 'updateResolvedTests': {
					const resolvedTestCode = typeof message.resolvedTestCode === 'string' ? message.resolvedTestCode : '';
					await this.updateResolvedTests(context, resolvedTestCode);
					break;
				}
				case 'clearWorkflowSession': {
					await this.clearWorkflowSession();
					break;
				}
				case 'useEditorSelection': {
					const target = message.target === 'tests' ? 'tests' : 'problem';
					const selection = getSelectedText();
					if (!selection) {
						this.appendUiLog('error', 'No editor selection found.');
						return;
					}
					if (target === 'tests') {
						this.setTestText(selection);
					} else {
						this.prefillProblem(selection);
					}
					break;
				}
				case 'openGeneratedCode': {
					const code = typeof message.code === 'string' ? message.code : '';
					if (code) {
						await openGeneratedCode(code);
					}
					break;
				}
				case 'insertGeneratedCode': {
					const code = typeof message.code === 'string' ? message.code : '';
					if (code) {
						await insertGeneratedCode(code);
					}
					break;
				}
				case 'openProfileConfig': {
					await openProfileConfigFile(context);
					break;
				}
				case 'reloadProfiles': {
					await this.loadProfiles(context);
					await this.postState();
					this.appendUiLog('info', 'Profiles reloaded from config file.');
					break;
				}
				case 'showOutput': {
					this.outputChannel.show(true);
					break;
				}
				default:
					break;
			}
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			this.appendUiLog('error', `Panel action failed: ${messageText}`);
		}
	}

	private async saveProfile(context: vscode.ExtensionContext, message: Record<string, unknown>): Promise<void> {
		const requestedId = typeof message.id === 'string' ? message.id : '';
		const name = typeof message.name === 'string' ? message.name.trim() : '';
		const baseUrl = typeof message.baseUrl === 'string' ? message.baseUrl.trim() : '';
		const modelRaw = typeof message.model === 'string' ? message.model.trim() : '';
		const model = modelRaw || 'gpt-5.4';
		const provider = normalizeProvider(typeof message.provider === 'string' ? message.provider : 'other');
		const apiKey = typeof message.apiKey === 'string' ? message.apiKey.trim() : '';

		if (!name) {
			this.appendUiLog('error', 'Profile name is required.');
			return;
		}

		const existingIndex = this.profiles.findIndex((profile) => profile.id === requestedId);
		if (existingIndex >= 0) {
			this.profiles[existingIndex] = {
				...this.profiles[existingIndex],
				name,
				baseUrl,
				model,
				provider,
				apiKey
			};
			this.activeProfileId = requestedId;
		} else {
			const id = createProfileId();
			this.profiles.push({
				id,
				name,
				baseUrl,
				model,
				provider,
				apiKey
			});
			this.activeProfileId = id;
		}

		await this.persistProfiles(context);
		await this.postState();
		this.appendUiLog('info', `Profile saved: ${name}`);
	}

	private async deleteProfile(context: vscode.ExtensionContext, message: Record<string, unknown>): Promise<void> {
		const profileId = typeof message.id === 'string' ? message.id : '';
		if (!profileId) {
			this.appendUiLog('error', 'Missing profile id.');
			return;
		}

		if (this.profiles.length <= 1) {
			this.appendUiLog('error', 'At least one profile must be kept.');
			return;
		}

		const previousLength = this.profiles.length;
		this.profiles = this.profiles.filter((profile) => profile.id !== profileId);
		if (this.profiles.length === previousLength) {
			this.appendUiLog('error', 'Profile not found.');
			return;
		}

		if (this.activeProfileId === profileId) {
			this.activeProfileId = this.profiles[0]?.id ?? '';
		}

		await this.persistProfiles(context);
		await this.postState();
		this.appendUiLog('info', 'Profile deleted.');
	}

	private validateRunRequest(request: RunRequest): Profile | undefined {
		const profile = this.getActiveProfile();
		if (!profile) {
			this.appendUiLog('error', 'No active profile. Please create one in Settings.');
			this.showSettingsPage();
			return undefined;
		}

		const problem = request.problem.trim();
		const testText = request.testText.trim();
		if (!problem) {
			this.appendUiLog('error', 'Problem input is required.');
			return undefined;
		}
		if (request.testMode === 'manual' && !testText) {
			this.appendUiLog('error', 'Test text is required in manual test mode.');
			return undefined;
		}
		if (!profile.apiKey && profile.provider !== 'ollama' && profile.provider !== 'vllm') {
			this.appendUiLog('error', `Profile "${profile.name}" does not have an API key.`);
			this.showSettingsPage();
			return undefined;
		}

		return profile;
	}

	private buildSessionArgs(profile: Profile, request: RunRequest): BackendSessionRequest {
		return {
			problem: request.problem.trim(),
			test_text: request.testText.trim(),
			test_mode: request.testMode,
			llm: {
				base_url: profile.baseUrl,
				api_key: profile.apiKey,
				model: profile.model,
				provider: profile.provider
			},
			context_enabled: request.contextEnabled,
			max_rounds: request.maxRounds,
			resolved_test_code: request.testMode === 'generate' ? request.resolvedTestCode?.trim() : undefined
		};
	}

	private postSessionState(stageResult?: BackendActionResult): void {
		this.postMessage({
			type: 'workflowSession',
			session: this.activeSession,
			stageResult,
			workflowMode: this.workflowMode,
			interactiveState: this.interactiveState,
			canResume: Boolean(this.resumeState),
			resumeLabel: this.resumeLabel(),
			interruptRequested: this.interruptRequested
		});
	}

	private parseActionRequest(message: Record<string, unknown>): {
		problem?: string;
		testText?: string;
		testMode?: TestMode;
		useErrorFeedback: boolean;
		contextEnabled?: boolean;
		maxRounds?: number;
		planOverride?: string;
		executionMode?: 'auto' | 'continue';
		resolvedTestCode?: string;
	} {
		const testMode: TestMode | undefined = message.testMode === 'generate'
			? 'generate'
			: message.testMode === 'manual'
				? 'manual'
				: undefined;
		const executionMode = message.executionMode === 'continue' ? 'continue' : message.executionMode === 'auto' ? 'auto' : undefined;

		return {
			problem: typeof message.problem === 'string' ? message.problem : undefined,
			testText: typeof message.testText === 'string' ? message.testText : undefined,
			testMode,
			useErrorFeedback: typeof message.useErrorFeedback === 'boolean' ? message.useErrorFeedback : true,
			contextEnabled: typeof message.contextEnabled === 'boolean' ? message.contextEnabled : undefined,
			maxRounds: typeof message.maxRounds === 'number' ? message.maxRounds : undefined,
			planOverride: typeof message.planOverride === 'string' ? message.planOverride : undefined,
			executionMode,
			resolvedTestCode: typeof message.resolvedTestCode === 'string' ? message.resolvedTestCode : undefined
		};
	}

	private setRunState(running: boolean, label = ''): void {
		this.postMessage({
			type: 'runState',
			running,
			label
		});
	}

	private async interruptWorkflow(): Promise<void> {
		if (!this.running) {
			return;
		}

		this.interruptRequested = true;
		this.setRunState(true, 'Stopping after the current stage...');
		await this.postState();

		if (this.workflowMode === 'auto' && this.activeSession?.session_id) {
			try {
				await this.backendServer.fetch(`/api/sessions/${this.activeSession.session_id}/interrupt`, {
					method: 'POST'
				});
			} catch (error) {
				this.appendUiLog('error', `Failed to request interrupt: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private async pauseIfInterrupted(resumeState: ResumeState, message: string): Promise<boolean> {
		if (!this.interruptRequested) {
			return false;
		}

		this.interruptRequested = false;
		this.resumeState = resumeState;
		await this.postState();
		this.postSessionState({
			stage: 'interrupt',
			message,
			interrupted: true,
			passed: this.activeSession?.passed ?? false
		});
		return true;
	}

	private async resumeWorkflow(context: vscode.ExtensionContext): Promise<void> {
		if (!this.resumeState) {
			return;
		}

		const resumeState = this.resumeState;
		this.resumeState = undefined;
		this.interruptRequested = false;
		await this.postState();

		if (resumeState.kind === 'interactive-initial-evaluate') {
			await this.runGuarded('Resuming with evaluation...', 'Resume failed', async () => {
				this.workflowMode = 'continue';
				await this.invokeWorkflowAction({
					action: 'evaluate',
					problem: resumeState.request.problem,
					testText: resumeState.request.testText,
					testMode: resumeState.request.testMode,
					useErrorFeedback: true,
					contextEnabled: resumeState.request.contextEnabled,
					maxRounds: resumeState.request.maxRounds
				});
				this.interactiveState = this.activeSession?.passed ? 'done' : 'await_failure_choice';
				this.postSessionState();
			});
			return;
		}

		if (resumeState.kind === 'interactive-plan-evaluate' || resumeState.kind === 'interactive-restart-evaluate') {
			await this.runGuarded('Resuming with evaluation...', 'Resume failed', async () => {
				this.workflowMode = 'continue';
				await this.invokeWorkflowAction({
					action: 'evaluate',
					problem: resumeState.request.problem,
					testText: resumeState.request.testText,
					testMode: resumeState.request.testMode,
					useErrorFeedback: resumeState.request.useErrorFeedback,
					contextEnabled: resumeState.request.contextEnabled,
					maxRounds: resumeState.request.maxRounds
				});
				this.interactiveState = this.activeSession?.passed ? 'done' : 'await_failure_choice';
				this.postSessionState();
			});
			return;
		}

		if (resumeState.kind === 'auto') {
			await this.runGuarded('Resuming auto workflow...', 'Resume failed', async () => {
				this.workflowMode = 'auto';
				const payload = await this.invokeWorkflowAction({
					action: 'auto_resume',
					useErrorFeedback: true,
					contextEnabled: resumeState.request.contextEnabled,
					maxRounds: resumeState.request.maxRounds
				});
				if (payload.stage_result?.interrupted) {
					this.resumeState = { kind: 'auto', request: resumeState.request };
				}
				this.interactiveState = this.activeSession?.passed ? 'done' : 'idle';
				await this.postState();
				this.postSessionState(payload.stage_result);
			});
		}
	}

	private async runGuarded(
		initialLabel: string,
		errorPrefix: string,
		work: () => Promise<void>
	): Promise<void> {
		if (this.running) {
			this.appendUiLog('error', 'A task is already running. Please wait.');
			return;
		}

		this.running = true;
		this.setRunState(true, initialLabel);
		this.startSessionPolling();
		try {
			await work();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.postMessage({
				type: 'workflowError',
				reason: `${errorPrefix}: ${message}`
			});
		} finally {
			await this.refreshActiveSession(true);
			this.stopSessionPolling();
			this.running = false;
			this.setRunState(false);
		}
	}

	private async createWorkflowSession(profile: Profile, request: RunRequest): Promise<void> {
		const payload = await this.backendServer.request<BackendResponse>('/api/sessions', {
			method: 'POST',
			body: JSON.stringify(this.buildSessionArgs(profile, request))
		});
		this.activeSession = payload.session;
		this.workflowMode = request.executionMode;
		this.interactiveState = 'idle';
		await this.postState();
		this.postSessionState();
	}

	private async syncWorkflowSession(profile: Profile, request: RunRequest): Promise<void> {
		if (!this.activeSession?.session_id) {
			await this.createWorkflowSession(profile, request);
			return;
		}

			const payload = await this.backendServer.request<BackendResponse>(
				`/api/sessions/${this.activeSession.session_id}`,
				{
					method: 'PATCH',
					body: JSON.stringify({
						problem: request.problem.trim(),
						test_text: request.testText.trim(),
						test_mode: request.testMode,
						context_enabled: request.contextEnabled,
						max_rounds: request.maxRounds,
						resolved_test_code: request.testMode === 'generate' ? request.resolvedTestCode?.trim() : undefined
					})
				}
			);
		this.activeSession = payload.session;
		this.workflowMode = request.executionMode;
		await this.postState();
		this.postSessionState();
	}

	private async ensureSessionForStandaloneTestAction(request: {
			problem?: string;
			testText?: string;
			testMode?: TestMode;
			contextEnabled?: boolean;
			maxRounds?: number;
			executionMode?: 'auto' | 'continue';
			resolvedTestCode?: string;
		}): Promise<boolean> {
		if (this.activeSession?.session_id) {
			return true;
		}

		const draftRequest: RunRequest = {
			problem: request.problem ?? '',
			testText: request.testText ?? '',
			testMode: request.testMode ?? 'generate',
			contextEnabled: request.contextEnabled ?? false,
			maxRounds: request.maxRounds ?? 10,
			executionMode: request.executionMode ?? this.workflowMode,
			resolvedTestCode: request.resolvedTestCode
		};
		const profile = this.validateRunRequest(draftRequest);
		if (!profile) {
			return false;
		}

		await this.createWorkflowSession(profile, draftRequest);
		return true;
	}

	private async invokeWorkflowAction(
		request: {
			action: string;
			problem?: string;
			testText?: string;
			testMode?: TestMode;
			useErrorFeedback: boolean;
			contextEnabled?: boolean;
			maxRounds?: number;
			planOverride?: string;
			resolvedTestCode?: string;
		}
	): Promise<BackendResponse> {
		if (!this.activeSession?.session_id) {
			throw new Error('No active workflow session. Start a session first.');
		}

		const payload = await this.backendServer.request<BackendResponse>(
			`/api/sessions/${this.activeSession.session_id}/actions`,
			{
				method: 'POST',
				body: JSON.stringify({
					action: request.action,
					problem: request.problem,
					test_text: request.testText,
					test_mode: request.testMode,
					use_error_feedback: request.useErrorFeedback,
					context_enabled: request.contextEnabled,
					max_rounds: request.maxRounds,
					plan_override: request.planOverride,
					resolved_test_code: request.resolvedTestCode
				})
			}
		);

		this.activeSession = payload.session;
		await this.postState();
		this.postSessionState(payload.stage_result);
		return payload;
	}

	private async executeWorkflow(_context: vscode.ExtensionContext, request: RunRequest): Promise<void> {
		const profile = this.validateRunRequest(request);
		if (!profile) {
			return;
		}

			await this.runGuarded(
				request.executionMode === 'auto' ? 'Starting auto workflow...' : 'Starting interactive workflow...',
				'Execution failed',
				async () => {
					this.clearResumeState();
					this.interruptRequested = false;
					const hadSession = Boolean(this.activeSession?.session_id);
					await this.syncWorkflowSession(profile, request);

				if (request.executionMode === 'auto') {
					this.setRunState(true, 'Running the full workflow until the retry limit...');
					const payload = await this.invokeWorkflowAction({
						action: 'auto',
						useErrorFeedback: true,
						contextEnabled: request.contextEnabled,
						maxRounds: request.maxRounds,
						resolvedTestCode: request.resolvedTestCode
					});
					if (payload.stage_result?.interrupted) {
						this.resumeState = { kind: 'auto', request };
						this.interruptRequested = false;
						await this.postState();
					}
					this.interactiveState = this.activeSession?.passed ? 'done' : 'idle';
					this.postSessionState();
					return;
				}

					this.setRunState(true, hadSession ? 'Restarting the current workflow from the latest setup...' : 'Generating initial code...');
					await this.invokeWorkflowAction({
						action: hadSession ? 'restart' : 'generate',
						problem: request.problem,
						testText: request.testText,
						testMode: request.testMode,
						useErrorFeedback: !hadSession,
						contextEnabled: request.contextEnabled,
						maxRounds: request.maxRounds,
						resolvedTestCode: request.resolvedTestCode
					});
				if (await this.pauseIfInterrupted(
					{ kind: 'interactive-initial-evaluate', request },
					'Interactive workflow paused after code generation. Resume to run evaluation.'
				)) {
					return;
				}

					this.setRunState(true, 'Evaluating generated code...');
					await this.invokeWorkflowAction({
						action: 'evaluate',
						problem: request.problem,
						testText: request.testText,
						testMode: request.testMode,
						useErrorFeedback: true,
						contextEnabled: request.contextEnabled,
						maxRounds: request.maxRounds,
						resolvedTestCode: request.resolvedTestCode
					});

				this.interruptRequested = false;
				if (this.activeSession?.passed) {
					this.interactiveState = 'done';
					this.postSessionState();
					return;
				}

				this.interactiveState = 'await_failure_choice';
				this.postSessionState();
			}
		);
	}

	private async continueWithPlan(
		_context: vscode.ExtensionContext,
		request: {
			problem?: string;
			testText?: string;
			testMode?: TestMode;
			useErrorFeedback: boolean;
			contextEnabled?: boolean;
			maxRounds?: number;
			planOverride?: string;
			resolvedTestCode?: string;
		}
	): Promise<void> {
		if (!this.activeSession?.session_id) {
			this.appendUiLog('error', 'No active workflow session. Start a session first.');
			return;
		}

		await this.runGuarded('Regenerating from the current plan...', 'Continue failed', async () => {
			this.workflowMode = 'continue';
			this.clearResumeState();
			this.setRunState(true, 'Saving the current plan and regenerating code...');
			await this.invokeWorkflowAction({
				action: 'regenerate',
				problem: request.problem,
				testText: request.testText,
				testMode: request.testMode,
				useErrorFeedback: true,
				contextEnabled: request.contextEnabled,
				maxRounds: request.maxRounds,
				planOverride: request.planOverride,
				resolvedTestCode: request.resolvedTestCode
			});
			if (await this.pauseIfInterrupted(
				{ kind: 'interactive-plan-evaluate', request },
				'Interactive workflow paused after regenerating code. Resume to run evaluation.'
			)) {
				return;
			}

			this.setRunState(true, 'Evaluating regenerated code...');
			await this.invokeWorkflowAction({
				action: 'evaluate',
				problem: request.problem,
				testText: request.testText,
				testMode: request.testMode,
				useErrorFeedback: true,
				contextEnabled: request.contextEnabled,
				maxRounds: request.maxRounds,
				resolvedTestCode: request.resolvedTestCode
			});

			this.interruptRequested = false;
			this.interactiveState = this.activeSession?.passed ? 'done' : 'await_failure_choice';
			this.postSessionState();
		});
	}

	private async continueWithFeedback(
		_context: vscode.ExtensionContext,
		request: {
			problem?: string;
			testText?: string;
			testMode?: TestMode;
			useErrorFeedback: boolean;
			contextEnabled?: boolean;
			maxRounds?: number;
			planOverride?: string;
			resolvedTestCode?: string;
		}
	): Promise<void> {
		if (!this.activeSession?.session_id) {
			this.appendUiLog('error', 'No active workflow session. Start a session first.');
			return;
		}

		await this.runGuarded('Creating a new plan from the latest feedback...', 'Plan failed', async () => {
			this.workflowMode = 'continue';
			this.clearResumeState();
			this.setRunState(true, 'Generating a fresh repair plan...');
			await this.invokeWorkflowAction({
				action: 'plan',
				problem: request.problem,
				testText: request.testText,
				testMode: request.testMode,
				useErrorFeedback: true,
				contextEnabled: request.contextEnabled,
				maxRounds: request.maxRounds,
				planOverride: request.planOverride,
				resolvedTestCode: request.resolvedTestCode
			});
			this.interruptRequested = false;
			this.interactiveState = 'await_plan';
			this.postSessionState();
		});
	}

	private async restartInteractiveWorkflow(
		_context: vscode.ExtensionContext,
		request: {
			problem?: string;
			testText?: string;
			testMode?: TestMode;
			useErrorFeedback: boolean;
			contextEnabled?: boolean;
			maxRounds?: number;
			planOverride?: string;
			resolvedTestCode?: string;
		}
	): Promise<void> {
		if (!this.activeSession?.session_id) {
			this.appendUiLog('error', 'No active workflow session. Start a session first.');
			return;
		}

		await this.runGuarded('Restarting from the original requirement...', 'Restart failed', async () => {
			this.workflowMode = 'continue';
			this.clearResumeState();
			this.setRunState(true, 'Generating a fresh attempt from the requirement...');
			await this.invokeWorkflowAction({
				action: 'restart',
				problem: request.problem,
				testText: request.testText,
				testMode: request.testMode,
				useErrorFeedback: false,
				contextEnabled: request.contextEnabled,
				maxRounds: request.maxRounds,
				resolvedTestCode: request.resolvedTestCode
			});
			if (await this.pauseIfInterrupted(
				{ kind: 'interactive-restart-evaluate', request },
				'Interactive workflow paused after restarting from the requirement. Resume to run evaluation.'
			)) {
				return;
			}

			this.setRunState(true, 'Evaluating the restarted attempt...');
			await this.invokeWorkflowAction({
				action: 'evaluate',
				problem: request.problem,
				testText: request.testText,
				testMode: request.testMode,
				useErrorFeedback: false,
				contextEnabled: request.contextEnabled,
				maxRounds: request.maxRounds,
				resolvedTestCode: request.resolvedTestCode
			});

			this.interruptRequested = false;
			this.interactiveState = this.activeSession?.passed ? 'done' : 'await_failure_choice';
			this.postSessionState();
		});
	}

	private async stopInteractiveWorkflow(): Promise<void> {
		if (!this.activeSession?.session_id) {
			return;
		}

		this.interactiveState = 'done';
		this.interruptRequested = false;
		this.clearResumeState();
		await this.postState();
		this.postSessionState({
			stage: 'interactive',
			message: 'Interactive workflow paused by the user.',
			passed: this.activeSession.passed
		});
	}

	private async runWorkflowAction(
		_context: vscode.ExtensionContext,
		request: {
			action: string;
			problem?: string;
			testText?: string;
			testMode?: TestMode;
			useErrorFeedback: boolean;
			contextEnabled?: boolean;
			maxRounds?: number;
			planOverride?: string;
			executionMode?: 'auto' | 'continue';
			resolvedTestCode?: string;
		}
	): Promise<void> {
		await this.runGuarded(`Running ${request.action}...`, 'Action failed', async () => {
			if (request.action === 'generate_tests') {
				const ready = await this.ensureSessionForStandaloneTestAction({
					problem: request.problem,
					testText: request.testText,
					testMode: request.testMode,
					contextEnabled: request.contextEnabled,
					maxRounds: request.maxRounds,
					executionMode: request.executionMode,
					resolvedTestCode: request.resolvedTestCode
				});
				if (!ready) {
					return;
				}
			}
			await this.invokeWorkflowAction({
				action: request.action,
				problem: request.problem,
				testText: request.testText,
				testMode: request.testMode,
				useErrorFeedback: request.useErrorFeedback,
				contextEnabled: request.contextEnabled,
				maxRounds: request.maxRounds,
				planOverride: request.planOverride,
				resolvedTestCode: request.resolvedTestCode
			});
			if (request.action === 'plan' && this.workflowMode === 'continue') {
				this.interactiveState = 'await_plan';
				this.postSessionState();
			}
		});
	}

	private async updateWorkflowPlan(_context: vscode.ExtensionContext, plan: string): Promise<void> {
		if (!this.activeSession?.session_id) {
			this.appendUiLog('error', 'No active workflow session.');
			return;
		}

		try {
			const payload = await this.backendServer.request<BackendResponse>(
				`/api/sessions/${this.activeSession.session_id}`,
				{
					method: 'PATCH',
					body: JSON.stringify({ plan })
				}
			);
			this.activeSession = payload.session;
			await this.postState();
			this.postSessionState();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.postMessage({
				type: 'workflowError',
				reason: `Failed to update plan: ${message}`
			});
		}
	}

	private async updateResolvedTests(_context: vscode.ExtensionContext, resolvedTestCode: string): Promise<void> {
		if (!this.activeSession?.session_id) {
			this.appendUiLog('error', 'No active workflow session.');
			return;
		}

		try {
			const payload = await this.backendServer.request<BackendResponse>(
				`/api/sessions/${this.activeSession.session_id}`,
				{
					method: 'PATCH',
					body: JSON.stringify({ resolved_test_code: resolvedTestCode })
				}
			);
			this.activeSession = payload.session;
			await this.postState();
			this.postSessionState();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.postMessage({
				type: 'workflowError',
				reason: `Failed to update resolved tests: ${message}`
			});
		}
	}

	private async clearWorkflowSession(): Promise<void> {
		this.stopSessionPolling();
		if (!this.activeSession?.session_id) {
			this.activeSession = undefined;
			this.workflowMode = 'auto';
			this.interactiveState = 'idle';
			this.interruptRequested = false;
			this.clearResumeState();
			this.lastSessionSnapshot = '';
			await this.postState();
			return;
		}

		try {
			await this.backendServer.fetch(`/api/sessions/${this.activeSession.session_id}`, {
				method: 'DELETE'
			});
		} catch {
			// Ignore cleanup failures for stale sessions.
		}

		this.activeSession = undefined;
		this.workflowMode = 'auto';
		this.interactiveState = 'idle';
		this.interruptRequested = false;
		this.clearResumeState();
		this.lastSessionSnapshot = '';
		await this.postState();
		this.postSessionState();
	}

	private appendUiLog(level: BridgeLogLevel, text: string): void {
		if (!text.trim()) {
			return;
		}
		this.postMessage({
			type: 'log',
			level,
			text
		});
	}

	private async loadProfiles(context: vscode.ExtensionContext): Promise<void> {
		const profilePath = resolveProfileConfigPath(context);
		const profileFileExists = fs.existsSync(profilePath);
		const fileData = await readProfilesFromFile(profilePath, this.outputChannel);
		if (fileData && fileData.profiles.length > 0) {
			this.profiles = fileData.profiles.map((profile) => ({
				id: profile.id || createProfileId(),
				name: profile.name || 'Default',
				baseUrl: profile.baseUrl || '',
				model: profile.model || 'gpt-5.4',
				provider: normalizeProvider(profile.provider),
				apiKey: profile.apiKey || ''
			}));
			const activeExists = this.profiles.some((profile) => profile.id === fileData.activeProfileId);
			this.activeProfileId = activeExists ? fileData.activeProfileId : this.profiles[0].id;
			return;
		}
		if (profileFileExists && !fileData) {
			this.appendUiLog('error', 'Profile config file is invalid. Fix JSON and click Reload.');
			if (this.profiles.length > 0) {
				return;
			}
		}

		const defaultProfile: Profile = {
			id: createProfileId(),
			name: 'Default',
			baseUrl: (getConfigurationValue<string>('baseUrl', '') || '').trim(),
			model: (getConfigurationValue<string>('model', 'gpt-5.4') || 'gpt-5.4').trim(),
			provider: 'other',
			apiKey: await readLegacyApiKey(context, this.outputChannel)
		};
		this.profiles = [defaultProfile];
		this.activeProfileId = defaultProfile.id;
		await this.persistProfiles(context);
	}

	private async persistProfiles(context: vscode.ExtensionContext): Promise<void> {
		const profilePath = resolveProfileConfigPath(context);
		const data: ProfileFileData = {
			version: PROFILE_FILE_VERSION,
			activeProfileId: this.activeProfileId,
			profiles: this.profiles
		};
		await writeProfilesToFile(profilePath, data, this.outputChannel);

		const activeProfile = this.getActiveProfile();
		if (activeProfile) {
			const config = getExtensionConfiguration();
			const target = getConfigurationTarget();
			await config.update('baseUrl', activeProfile.baseUrl, target);
			await config.update('model', activeProfile.model, target);
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(EXTENSION_DISPLAY_NAME);
	context.subscriptions.push(outputChannel);

	const ensureSidebarProvider = async (): Promise<AdacoderChatPanel> => {
		try {
			return await AdacoderChatPanel.createOrShow(context, outputChannel);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`[activate error] ${message}`);
			throw error;
		}
	};

	void ensureSidebarProvider();

	const registerCommand = (suffix: string, callback: () => Promise<void>) => {
		return [
			vscode.commands.registerCommand(`${EXTENSION_ID}.${suffix}`, callback),
			vscode.commands.registerCommand(`${LEGACY_EXTENSION_ID}.${suffix}`, callback)
		];
	};

	const openChatDisposables = registerCommand('openChat', async () => {
		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showTaskPage();
	});

	const openSettingsDisposables = registerCommand('openSettings', async () => {
		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showSettingsPage();
	});

	const openProfileConfigDisposables = registerCommand('openProfileConfig', async () => {
		await openProfileConfigFile(context);
		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showSettingsPage();
	});

	const runWorkflowDisposables = registerCommand('runWorkflow', async () => {
		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showTaskPage();

		const selection = getSelectedText();
		if (selection) {
			panel.prefillProblem(selection);
		}
	});

	const runFromSelectionDisposables = registerCommand('runFromSelection', async () => {
		const selection = getSelectedText();
		if (!selection) {
			void vscode.window.showWarningMessage('Please select code or text first.');
			return;
		}

		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showTaskPage();
		panel.prefillProblem(selection);
		void vscode.window.showInformationMessage('Requirement text loaded from the current selection.');
	});

	context.subscriptions.push(
		...openChatDisposables,
		...openSettingsDisposables,
		...openProfileConfigDisposables,
		...runWorkflowDisposables,
		...runFromSelectionDisposables
	);
}

export function deactivate() {
	AdacoderChatPanel.currentPanel?.disposeRuntime();
}

function getConfigurationTarget(): vscode.ConfigurationTarget {
	return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
}

function getExtensionConfiguration(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(EXTENSION_ID);
}

function getLegacyConfiguration(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(LEGACY_EXTENSION_ID);
}

function hasConfigurationOverride(section: string, key: string): boolean {
	const inspect = vscode.workspace.getConfiguration(section).inspect(key);
	return inspect?.workspaceFolderValue !== undefined
		|| inspect?.workspaceValue !== undefined
		|| inspect?.globalValue !== undefined;
}

function getConfigurationValue<T>(key: string, defaultValue: T): T {
	if (hasConfigurationOverride(EXTENSION_ID, key)) {
		return getExtensionConfiguration().get<T>(key, defaultValue);
	}
	if (hasConfigurationOverride(LEGACY_EXTENSION_ID, key)) {
		return getLegacyConfiguration().get<T>(key, defaultValue);
	}
	return getExtensionConfiguration().get<T>(key, defaultValue);
}

function createProfileId(): string {
	return randomBytes(8).toString('hex');
}

function normalizeProvider(value: string | undefined): ProviderType {
	switch (value) {
		case 'openai':
		case 'claude':
		case 'other':
		case 'ollama':
		case 'vllm':
			return value;
		default:
			return 'other';
	}
}

function resolveProfileConfigPath(context: vscode.ExtensionContext): string {
	const configuredPath = (getConfigurationValue<string>('profileConfigPath', DEFAULT_PROFILE_CONFIG_RELATIVE_PATH) || '').trim();
	const rawPath = configuredPath || DEFAULT_PROFILE_CONFIG_RELATIVE_PATH;
	const expandedPath = expandPathVariables(rawPath, context);
	const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : resolveRelativePath(expandedPath, context);

	const usesDefaultPath = rawPath === DEFAULT_PROFILE_CONFIG_RELATIVE_PATH;
	const hasCustomPath = hasConfigurationOverride(EXTENSION_ID, 'profileConfigPath')
		|| hasConfigurationOverride(LEGACY_EXTENSION_ID, 'profileConfigPath');
	if (!hasCustomPath && usesDefaultPath && !fs.existsSync(resolvedPath)) {
		const legacyExpandedPath = expandPathVariables(LEGACY_PROFILE_CONFIG_RELATIVE_PATH, context);
		const legacyResolvedPath = path.isAbsolute(legacyExpandedPath)
			? legacyExpandedPath
			: resolveRelativePath(legacyExpandedPath, context);
		if (fs.existsSync(legacyResolvedPath)) {
			return legacyResolvedPath;
		}
	}

	return resolvedPath;
}

async function openProfileConfigFile(context: vscode.ExtensionContext): Promise<void> {
	const profilePath = resolveProfileConfigPath(context);
	if (!fs.existsSync(profilePath)) {
		const emptyData: ProfileFileData = {
			version: PROFILE_FILE_VERSION,
			activeProfileId: '',
			profiles: []
		};
		fs.mkdirSync(path.dirname(profilePath), { recursive: true });
		fs.writeFileSync(profilePath, `${JSON.stringify(emptyData, null, 2)}\n`, 'utf8');
	}

	const doc = await vscode.workspace.openTextDocument(profilePath);
	await vscode.window.showTextDocument(doc, { preview: false });
}

async function readLegacyApiKey(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel
): Promise<string> {
	try {
		return (await context.secrets.get(LEGACY_API_KEY_SECRET)) ?? '';
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[warning] Failed to read legacy api key: ${message}`);
		return '';
	}
}

async function readProfilesFromFile(
	profilePath: string,
	outputChannel: vscode.OutputChannel
): Promise<ProfileFileData | undefined> {
	if (!fs.existsSync(profilePath)) {
		return undefined;
	}

	try {
		const raw = fs.readFileSync(profilePath, 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) {
			return undefined;
		}

		const rawProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
		const profiles: Profile[] = rawProfiles
			.map((item) => {
				if (!isRecord(item)) {
					return undefined;
				}
				return {
					id: typeof item.id === 'string' && item.id ? item.id : createProfileId(),
					name: typeof item.name === 'string' && item.name ? item.name : 'Profile',
					baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
					model: typeof item.model === 'string' && item.model ? item.model : 'gpt-5.4',
					provider: normalizeProvider(typeof item.provider === 'string' ? item.provider : 'other'),
					apiKey: typeof item.apiKey === 'string' ? item.apiKey : ''
				};
			})
			.filter((item): item is Profile => Boolean(item));

		const activeProfileId = typeof parsed.activeProfileId === 'string' ? parsed.activeProfileId : '';
		return {
			version: PROFILE_FILE_VERSION,
			activeProfileId,
			profiles
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[warning] Failed to read profile file: ${message}`);
		return undefined;
	}
}

async function writeProfilesToFile(
	profilePath: string,
	data: ProfileFileData,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	try {
		fs.mkdirSync(path.dirname(profilePath), { recursive: true });
		fs.writeFileSync(profilePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`[error] Failed to write profile file: ${message}`);
		throw new Error(`Failed to write profile file: ${message}`);
	}
}

function getSelectedText(): string {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.selection.isEmpty) {
		return '';
	}
	return editor.document.getText(editor.selection).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getWorkspaceRootPath(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function expandPathVariables(input: string, context: vscode.ExtensionContext): string {
	let result = input;
	const workspaceRoot = getWorkspaceRootPath();
	if (workspaceRoot) {
		result = result.replaceAll('${workspaceFolder}', workspaceRoot);
	}
	result = result.replaceAll('${extensionPath}', context.extensionPath);
	return result;
}

function resolveRelativePath(input: string, context: vscode.ExtensionContext): string {
	const workspaceRoot = getWorkspaceRootPath();
	const candidates: string[] = [];
	if (workspaceRoot) {
		candidates.push(path.join(workspaceRoot, input));
	}
	candidates.push(path.join(context.extensionPath, input));

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return candidates[0] ?? input;
}

function resolveBackendEntryPath(context: vscode.ExtensionContext): string {
	const configuredPath = (
		getConfigurationValue<string>('backendPath', DEFAULT_BACKEND_ENTRY_RELATIVE_PATH)
		|| DEFAULT_BACKEND_ENTRY_RELATIVE_PATH
	).trim();
	const expandedPath = expandPathVariables(configuredPath, context);
	let resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : resolveRelativePath(expandedPath, context);

	if (!fs.existsSync(resolvedPath)) {
		const legacyPath = (getConfigurationValue<string>('bridgePath', '') || '').trim();
		if (legacyPath) {
			const expandedLegacyPath = expandPathVariables(legacyPath, context);
			const resolvedLegacyPath = path.isAbsolute(expandedLegacyPath)
				? expandedLegacyPath
				: resolveRelativePath(expandedLegacyPath, context);
			const siblingMainPath = path.join(path.dirname(resolvedLegacyPath), 'main.py');
			if (fs.existsSync(siblingMainPath)) {
				resolvedPath = siblingMainPath;
			}
		}
	}

	return resolvedPath;
}

function detectPythonPath(context: vscode.ExtensionContext): string | undefined {
	const workspaceRoot = getWorkspaceRootPath();
	const candidates: string[] = [];
	if (workspaceRoot) {
		candidates.push(path.join(workspaceRoot, '.venv', 'bin', 'python'));
		candidates.push(path.join(workspaceRoot, 'backend', '.venv', 'bin', 'python'));
		candidates.push(path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe'));
		candidates.push(path.join(workspaceRoot, 'backend', '.venv', 'Scripts', 'python.exe'));
	}
	candidates.push(path.join(context.extensionPath, 'backend', '.venv', 'bin', 'python'));
	candidates.push(path.join(context.extensionPath, 'backend', '.venv', 'Scripts', 'python.exe'));

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

function resolvePythonPath(context: vscode.ExtensionContext): string {
	const hasUserOverride = hasConfigurationOverride(EXTENSION_ID, 'pythonPath')
		|| hasConfigurationOverride(LEGACY_EXTENSION_ID, 'pythonPath');
	const configured = (getConfigurationValue<string>('pythonPath', 'python3') || 'python3').trim();
	if (!hasUserOverride) {
		const detected = detectPythonPath(context);
		if (detected) {
			return detected;
		}
	}

	if (!configured) {
		return 'python3';
	}

	const expanded = expandPathVariables(configured, context);
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	const looksLikePath = expanded.includes('/') || expanded.includes('\\') || expanded.startsWith('.');
	if (!looksLikePath) {
		return expanded;
	}
	return resolveRelativePath(expanded, context);
}

async function openGeneratedCode(code: string): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({
		language: 'python',
		content: code
	});
	await vscode.window.showTextDocument(doc, { preview: false });
}

async function insertGeneratedCode(code: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		throw new Error('No active editor found for code insertion.');
	}

	const selection = editor.selection;
	const hasSelection = !selection.isEmpty;
	const ok = await editor.edit((editBuilder) => {
		if (hasSelection) {
			editBuilder.replace(selection, code);
			return;
		}
		editBuilder.insert(selection.active, code);
	});

	if (!ok) {
		throw new Error('Failed to insert generated code into the editor.');
	}
}

function getChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = randomBytes(16).toString('base64');
	const csp = [
		"default-src 'none'",
		`img-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src ${webview.cspSource} 'nonce-${nonce}'`
	].join('; ');
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'));
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'));

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<link rel="stylesheet" href="${styleUri}" />
	<title>${EXTENSION_DISPLAY_NAME}</title>
</head>
<body>
	<div class="app-shell">
		<header class="app-header">
			<div class="brand">
				<div class="brand-title">${EXTENSION_DISPLAY_NAME}</div>
				<div class="brand-subtitle">Workflow</div>
			</div>
			<div class="header-actions">
				<button class="btn subtle" id="showOutputBtn" type="button">Logs</button>
				<button class="btn subtle" id="openSettingsBtn" type="button">Profiles</button>
			</div>
		</header>

		<main class="page active" id="taskPage">
			<section class="setup-shell">
				<div class="section-header">
					<div>
						<div class="panel-title">Setup</div>
						<div class="panel-copy">Keep model settings and test setup here before you send the next task.</div>
					</div>
				</div>
				<div class="setup-grid">
					<section class="setup-block">
						<div class="setup-block-header">
							<div class="mini-heading">Model</div>
							<div class="hint">Profile and context behavior for the next run.</div>
						</div>
						<div class="field compact-field">
							<label for="taskProfileSelect">LLM Profile</label>
							<select id="taskProfileSelect"></select>
						</div>
						<label class="checkbox-chip" for="contextEnabledInput">
							<input id="contextEnabledInput" type="checkbox" />
							<span>Use Context</span>
						</label>
					</section>

					<section class="setup-block">
						<div class="setup-block-header">
							<div class="panel-header">
								<div>
									<div class="mini-heading">Tests</div>
									<div class="hint">Manual tests run directly. Generated tests stay isolated from workflow context.</div>
								</div>
								<div class="field compact-field narrow-field">
									<label for="testModeSelect">Test Mode</label>
									<select id="testModeSelect">
										<option value="manual">Manual Tests</option>
										<option value="generate">Generate Tests</option>
									</select>
								</div>
							</div>
						</div>
						<div class="manual-tests-shell" id="manualTestsSection">
							<textarea id="testInput" placeholder="Paste runnable Python tests here. They will run against the generated code directly."></textarea>
							<div class="action-row">
								<button class="btn secondary" id="useSelectionForTestsBtn" type="button">Selection To Tests</button>
							</div>
						</div>
						<div class="generated-tests-shell hidden" id="testsWorkspaceSection">
							<div class="generated-tests-header">
								<div class="mini-heading">Generated Test Suite</div>
								<div class="hint" id="resolvedTestsHint">Switch to generated tests mode to work with a separate editable test suite.</div>
							</div>
							<textarea id="resolvedTestsEditor" placeholder="Generated runnable assert tests will appear here. You can edit them before applying."></textarea>
							<div class="generated-tests-preview" id="resolvedTestsPreview"></div>
							<div class="action-row">
								<button class="btn secondary" id="generateTestsBtn" type="button">Generate Tests</button>
								<button class="btn secondary" id="saveResolvedTestsBtn" type="button">Use Edited Tests</button>
							</div>
						</div>
					</section>
				</div>
			</section>

			<section class="conversation-shell">
				<div class="section-header conversation-header">
					<div>
						<div class="panel-title">Conversation</div>
						<div class="panel-copy">Requirements, code, run results, and plans appear here in order.</div>
					</div>
				</div>
				<div class="conversation-scroll" id="conversationScroll">
					<div class="timeline" id="timeline"></div>
				</div>
			</section>

			<section class="composer-shell">
				<textarea id="problemInput" placeholder="Describe the coding task, constraints, expected behavior, and anything the model must preserve."></textarea>
				<div class="composer-row">
					<button class="btn secondary" id="useSelectionForProblemBtn" type="button">Selection To Prompt</button>
					<select id="executionModeSelect" aria-label="Execution Mode">
						<option value="auto">Auto Full Workflow</option>
						<option value="continue">Interactive Continue</option>
					</select>
					<button class="btn" id="submitWorkflowBtn" type="button">Send</button>
					<button class="btn secondary" id="resumeWorkflowBtn" type="button">Resume</button>
					<button class="btn secondary" id="interruptWorkflowBtn" type="button">Stop</button>
					<button class="btn subtle" id="clearSessionBtn" type="button">New Task</button>
				</div>
				<div class="composer-status" id="composerStatus" aria-live="polite"></div>
				<div class="composer-note">Press Ctrl/Cmd+Enter to send. Stop pauses after the current stage. Resume continues a paused workflow. New Task clears the current session.</div>
			</section>
		</main>

		<main class="page" id="settingsPage">
			<section class="panel">
				<div class="panel-header">
					<div>
						<div class="panel-title">Profile Settings</div>
						<div class="panel-copy">Manage OpenAI-compatible, Claude, Ollama, or vLLM profiles. The active profile is used by the workflow page.</div>
					</div>
					<button class="btn subtle" id="backToWorkflowBtn" type="button">Back</button>
				</div>

				<div class="form-grid">
					<div class="field span-2">
						<label for="settingsProfileSelect">Edit Profile</label>
						<select id="settingsProfileSelect"></select>
					</div>
					<div class="field">
						<label for="profileNameInput">Profile Name</label>
						<input id="profileNameInput" type="text" placeholder="Local GPT-5.4" />
					</div>
					<div class="field">
						<label for="profileProviderSelect">Provider</label>
						<select id="profileProviderSelect">
							<option value="other">OpenAI-Compatible</option>
							<option value="openai">OpenAI</option>
							<option value="claude">Claude</option>
							<option value="ollama">Ollama</option>
							<option value="vllm">vLLM</option>
						</select>
					</div>
					<div class="field">
						<label for="profileBaseUrlInput">Base URL</label>
						<input id="profileBaseUrlInput" type="text" placeholder="https://api.openai.com/v1" />
					</div>
					<div class="field">
						<label for="profileModelInput">Model</label>
						<input id="profileModelInput" type="text" placeholder="gpt-5.4" />
					</div>
					<div class="field span-2">
						<label for="profileApiKeyInput">API Key</label>
						<input id="profileApiKeyInput" type="password" placeholder="sk-..." />
						<div class="field-hint">Optional for Ollama and vLLM. Required for hosted providers.</div>
					</div>
				</div>

				<div class="hint" id="profileHint">Create a new profile and save it.</div>

				<div class="button-grid">
					<button class="btn secondary" id="newProfileBtn" type="button">New Profile</button>
					<button class="btn secondary" id="openProfileConfigBtn" type="button">Open Config</button>
					<button class="btn secondary" id="reloadProfilesBtn" type="button">Reload Profiles</button>
					<button class="btn secondary" id="deleteProfileBtn" type="button">Delete Profile</button>
					<button class="btn" id="saveProfileBtn" type="button">Save Profile</button>
				</div>
			</section>
		</main>
	</div>

	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
