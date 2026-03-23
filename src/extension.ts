import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

interface WorkflowArgs {
	base_url: string;
	api_key: string;
	model: string;
	provider: ProviderType;
	problem: string;
	test_file_path: string;
}

interface BridgeResponse {
	id: string | null;
	ok: boolean;
	result?: unknown;
	error?: string;
	traceback?: string;
}

type WorkflowResult = {
	passed?: boolean;
	code?: string;
	[key: string]: unknown;
};

type BridgeLogLevel = 'runtime' | 'stdout' | 'stderr' | 'info' | 'error';

interface RunRequest {
	problem: string;
	testFilePath: string;
}

type ProviderType = 'openai' | 'claude' | 'other' | 'ollama' | 'vllm';

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

const LEGACY_API_KEY_SECRET = 'adacoder.apiKey';
const PROFILE_FILE_VERSION = 1;
const DEFAULT_PROFILE_CONFIG_RELATIVE_PATH = '.vscode/adacoder-profiles.json';

class AdacoderChatPanel implements vscode.WebviewViewProvider {
	public static readonly viewType = 'adacoder.sidebarView';
	private static readonly containerCommand = 'workbench.view.extension.adacoder-sidebar';
	private static currentPanel: AdacoderChatPanel | undefined;

	private readonly providerDisposable: vscode.Disposable;
	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly viewDisposables: vscode.Disposable[] = [];
	private running = false;
	private profiles: Profile[] = [];
	private activeProfileId = '';
	private preferredPage: 'task' | 'settings' = 'task';
	private pendingProblem = '';
	private pendingTestPath = '';

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel
	) {
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

	public setTestPath(testFilePath: string): void {
		this.pendingTestPath = testFilePath;
		this.postMessage({
			type: 'setTestPath',
			testFilePath
		});
	}

	public async runWorkflow(context: vscode.ExtensionContext, request: RunRequest): Promise<void> {
		await this.executeWorkflow(context, request);
	}

	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getChatHtml(webviewView.webview);

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
		if (this.pendingTestPath) {
			this.postMessage({ type: 'setTestPath', testFilePath: this.pendingTestPath });
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
			activeProfileId: this.activeProfileId
		});
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
					const testFilePath = typeof message.testFilePath === 'string' ? message.testFilePath : '';
					await this.executeWorkflow(context, { problem, testFilePath });
					break;
				}
				case 'selectTestFile': {
					const selectedPath = await pickTestFilePath();
					if (selectedPath) {
						this.setTestPath(selectedPath);
					}
					break;
				}
				case 'useEditorSelection': {
					const selection = getSelectedText();
					if (!selection) {
						this.appendUiLog('error', 'No editor selection found.');
						return;
					}
					this.prefillProblem(selection);
					break;
				}
				case 'openGeneratedCode': {
					const code = typeof message.code === 'string' ? message.code : '';
					if (code) {
						await openGeneratedCode(code);
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

	private async executeWorkflow(context: vscode.ExtensionContext, request: RunRequest): Promise<void> {
		if (this.running) {
			this.appendUiLog('error', 'A task is already running. Please wait.');
			return;
		}

		const profile = this.getActiveProfile();
		if (!profile) {
			this.appendUiLog('error', 'No active profile. Please create one in Settings.');
			this.showSettingsPage();
			return;
		}

		const problem = request.problem.trim();
		const testFilePath = request.testFilePath.trim();
		if (!problem) {
			this.appendUiLog('error', 'Problem input is required.');
			return;
		}
		if (!testFilePath) {
			this.appendUiLog('error', 'Test file path is required.');
			return;
		}
		if (!profile.apiKey) {
			this.appendUiLog('error', `Profile "${profile.name}" does not have an API key.`);
			this.showSettingsPage();
			return;
		}

		this.running = true;
		this.postMessage({ type: 'runState', running: true });

		try {
			const args: WorkflowArgs = {
				base_url: profile.baseUrl,
				api_key: profile.apiKey,
				model: profile.model,
				provider: profile.provider,
				problem,
				test_file_path: testFilePath
			};

			const response = await invokeBridge(context, args, this.outputChannel);

			if (!response.ok) {
				const detail = response.traceback ? `\n${response.traceback}` : '';
				this.postMessage({
					type: 'workflowError',
					reason: `Backend error: ${response.error ?? 'Unknown error'}${detail}`
				});
				return;
			}

			const result = response.result as WorkflowResult | undefined;
			const passed = Boolean(result?.passed);
			const generatedCode = typeof result?.code === 'string' ? result.code : '';
			const failureReason = passed ? '' : extractFailureReason(result);
			this.postMessage({
				type: 'workflowResult',
				passed,
				result,
				code: passed ? generatedCode : '',
				failureReason
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.postMessage({
				type: 'workflowError',
				reason: `Execution failed: ${message}`
			});
		} finally {
			this.running = false;
			this.postMessage({ type: 'runState', running: false });
		}
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

		const config = vscode.workspace.getConfiguration('adacoder');
		const defaultProfile: Profile = {
			id: createProfileId(),
			name: 'Default',
			baseUrl: (config.get<string>('baseUrl', '') || '').trim(),
			model: (config.get<string>('model', 'gpt-5.4') || 'gpt-5.4').trim(),
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
			const config = vscode.workspace.getConfiguration('adacoder');
			const target = getConfigurationTarget();
			await config.update('baseUrl', activeProfile.baseUrl, target);
			await config.update('model', activeProfile.model, target);
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('Adacoder');
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

	const openChatDisposable = vscode.commands.registerCommand('adacoder.openChat', async () => {
		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showTaskPage();
	});

	const openSettingsDisposable = vscode.commands.registerCommand('adacoder.openSettings', async () => {
		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showSettingsPage();
	});

	const openProfileConfigDisposable = vscode.commands.registerCommand('adacoder.openProfileConfig', async () => {
		await openProfileConfigFile(context);
		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showSettingsPage();
	});

	const runWorkflowDisposable = vscode.commands.registerCommand('adacoder.runWorkflow', async () => {
		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showTaskPage();

		const selection = getSelectedText();
		if (selection) {
			panel.prefillProblem(selection);
		}
	});

	const runFromSelectionDisposable = vscode.commands.registerCommand('adacoder.runFromSelection', async () => {
		const selection = getSelectedText();
		if (!selection) {
			void vscode.window.showWarningMessage('Please select code or text first.');
			return;
		}

		const testFilePath = await pickTestFilePath();
		if (!testFilePath) {
			return;
		}

		const panel = await ensureSidebarProvider();
		await panel.reveal();
		panel.showTaskPage();
		panel.prefillProblem(selection);
		panel.setTestPath(testFilePath);
		void vscode.window.showInformationMessage('Test file selected. Click "Run Workflow" to start.');
	});

	context.subscriptions.push(
		openChatDisposable,
		openSettingsDisposable,
		openProfileConfigDisposable,
		runWorkflowDisposable,
		runFromSelectionDisposable
	);
}

export function deactivate() {}

function getConfigurationTarget(): vscode.ConfigurationTarget {
	return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
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
	const config = vscode.workspace.getConfiguration('adacoder');
	const configuredPath = (config.get<string>('profileConfigPath', DEFAULT_PROFILE_CONFIG_RELATIVE_PATH) || '').trim();
	const rawPath = configuredPath || DEFAULT_PROFILE_CONFIG_RELATIVE_PATH;
	const expandedPath = expandPathVariables(rawPath, context);
	return path.isAbsolute(expandedPath) ? expandedPath : resolveRelativePath(expandedPath, context);
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

async function pickTestFilePath(): Promise<string | undefined> {
	const selected = await vscode.window.showOpenDialog({
		title: 'Select test file (test_file_path)',
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
	});
	if (!selected || selected.length === 0) {
		return undefined;
	}
	return selected[0].fsPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function extractFailureReason(result: WorkflowResult | undefined): string {
	if (!result || !isRecord(result)) {
		return 'Workflow failed without a detailed reason.';
	}

	const candidateKeys = [
		'error',
		'reason',
		'message',
		'failureReason',
		'failure_reason',
		'stderr',
		'traceback'
	];

	for (const key of candidateKeys) {
		const value = result[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}

	return 'Workflow failed without a detailed reason.';
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

function resolveBridgePath(context: vscode.ExtensionContext): string {
	const config = vscode.workspace.getConfiguration('adacoder');
	const configuredPath = (config.get<string>('bridgePath', 'backend/bridge.py') || 'backend/bridge.py').trim();
	const expandedPath = expandPathVariables(configuredPath, context);
	return path.isAbsolute(expandedPath) ? expandedPath : resolveRelativePath(expandedPath, context);
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
	const config = vscode.workspace.getConfiguration('adacoder');
	const inspect = config.inspect<string>('pythonPath');
	const hasUserOverride = Boolean(
		inspect?.workspaceValue ?? inspect?.workspaceFolderValue ?? inspect?.globalValue
	);
	const configured = (config.get<string>('pythonPath', 'python3') || 'python3').trim();
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

function invokeBridge(
	context: vscode.ExtensionContext,
	args: WorkflowArgs,
	outputChannel: vscode.OutputChannel
): Promise<BridgeResponse> {
	return new Promise((resolve, reject) => {
		const bridgePath = resolveBridgePath(context);
		if (!fs.existsSync(bridgePath)) {
			reject(new Error(`bridge.py not found: ${bridgePath}`));
			return;
		}

		const pythonPath = resolvePythonPath(context);
		const requestId = `${Date.now()}`;
		const request = {
			id: requestId,
			method: 'workflow',
			args
		};

		outputChannel.appendLine(`[runtime] python=${pythonPath}`);
		outputChannel.appendLine(`[runtime] bridge=${bridgePath}`);
		outputChannel.appendLine(`[request] ${JSON.stringify(request, null, 2)}`);

		const child = spawn(pythonPath, [bridgePath], {
			cwd: path.dirname(bridgePath),
			stdio: ['pipe', 'pipe', 'pipe']
		});
		const rl = readline.createInterface({ input: child.stdout });
		let settled = false;

		const timeoutHandle = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rl.close();
			child.kill();
			reject(new Error('Timed out waiting for backend response (300s).'));
		}, 300_000);

		const cleanup = (): void => {
			clearTimeout(timeoutHandle);
			rl.close();
		};

		child.stderr.on('data', (buffer: Buffer) => {
			const text = buffer.toString().trim();
			if (!text) {
				return;
			}
			outputChannel.appendLine(`[stderr] ${text}`);
		});

		child.on('error', (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(new Error(`Failed to start Python process: ${error.message}`));
		});

		child.on('exit', (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(new Error(`Backend process exited early, code=${code ?? 'null'} signal=${signal ?? 'null'}`));
		});

		rl.on('line', (line: string) => {
			if (!line.trim()) {
				return;
			}
			outputChannel.appendLine(`[stdout] ${line}`);

			try {
				const parsed = JSON.parse(line) as BridgeResponse;
				if (parsed.id !== requestId && parsed.id !== null) {
					return;
				}
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				child.stdin.end();
				resolve(parsed);
			} catch {
				// Non-JSON stdout is already written to the output channel.
			}
		});

		child.stdin.write(`${JSON.stringify(request)}\n`);
	});
}

async function openGeneratedCode(code: string): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({
		language: 'python',
		content: code
	});
	await vscode.window.showTextDocument(doc, { preview: false });
}

function getChatHtml(webview: vscode.Webview): string {
	const nonce = randomBytes(16).toString('base64');
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		'img-src data:'
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Adacoder</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --error: var(--vscode-errorForeground);
      --ok: var(--vscode-testing-iconPassed);
      --warn: var(--vscode-editorWarning-foreground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      background: var(--bg);
      color: var(--fg);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding: 10px 12px;
      gap: 10px;
    }
    .title { font-size: 14px; font-weight: 600; }
    .header-actions { display: flex; gap: 6px; }
    button {
      border: none;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover { background: var(--btn-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .tabs { display: flex; border-bottom: 1px solid var(--border); }
    .tab-btn {
      flex: 1;
      background: transparent;
      border-radius: 0;
      border: none;
      border-right: 1px solid var(--border);
      color: var(--muted);
      padding: 9px 10px;
    }
    .tab-btn:last-child { border-right: none; }
    .tab-btn.active { color: var(--fg); background: var(--input-bg); }
    .page {
      display: none;
      height: calc(100vh - 92px);
      overflow: auto;
      padding: 12px;
      gap: 10px;
      flex-direction: column;
    }
    .page.active { display: flex; }
    .section {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .row label {
      min-width: 70px;
      color: var(--muted);
      font-size: 12px;
    }
    select, input, textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      padding: 8px 10px;
      font: inherit;
    }
    textarea {
      resize: vertical;
      min-height: 120px;
      line-height: 1.45;
    }
    .path-row { display: flex; gap: 8px; }
    .path-row input { flex: 1; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
    .status { font-size: 12px; color: var(--muted); }
    .logs {
      border: none;
      border-radius: 0;
      padding: 8px 6px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: 360px;
      overflow: auto;
    }
    .log {
      border: none;
      border-radius: 0;
      padding: 0;
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
      background: transparent;
    }
    .log.runtime { color: var(--muted); }
    .log.loading { color: var(--muted); font-style: italic; }
    .log.stderr, .log.error, .log.result-fail { color: var(--error); }
    .log.result-pass { color: var(--fg); }
    .log.code-block { color: var(--fg); }
    .log.user-request { color: var(--fg); }
    .log .md-paragraph { margin: 0; }
    .log .md-heading { font-weight: 600; margin: 0; }
    .log .md-heading.md-h1 { font-size: 15px; }
    .log .md-heading.md-h2 { font-size: 14px; }
    .log .md-heading.md-h3 { font-size: 13px; }
    .log ul { margin: 2px 0 0 18px; padding: 0; }
    .log li { margin: 2px 0; }
    .log code { background: var(--input-bg); padding: 1px 4px; border-radius: 4px; }
    .md-divider { border-top: 1px solid var(--border); margin: 4px 0; }
    .task-separator {
      display: flex;
      align-items: center;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      gap: 10px;
      margin: 10px 0 6px;
    }
    .task-separator::before,
    .task-separator::after {
      content: '';
      flex: 1;
      border-top: 1px dashed var(--border);
    }
    .task-separator span {
      white-space: nowrap;
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--input-bg);
    }
    .hint { font-size: 12px; color: var(--muted); }
    pre {
      margin: 6px 0 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      overflow: auto;
      max-height: 260px;
      background: var(--input-bg);
    }
    .task-page {
      padding: 0;
      gap: 0;
      overflow: hidden;
      height: calc(100vh - 92px);
    }
    .task-toolbar {
      border-bottom: 1px solid var(--border);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--bg);
    }
    .task-toolbar-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .task-toolbar-row label {
      min-width: 68px;
      color: var(--muted);
      font-size: 12px;
    }
    .task-toolbar-row .path-row {
      flex: 1;
    }
    .chat-stream {
      flex: 1;
      min-height: 0;
      max-height: none;
      margin: 12px;
      border-radius: 10px;
    }
    .composer {
      border-top: 1px solid var(--border);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--bg);
    }
    .composer textarea {
      min-height: 96px;
      max-height: 220px;
    }
    .composer-path-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .composer-path-row input {
      flex: 1;
    }
    .composer-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .composer-actions .actions {
      margin-left: auto;
    }
    pre code {
      display: block;
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre;
    }
    .hl-comment { color: var(--vscode-descriptionForeground, #6a9955); }
    .hl-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
    .hl-keyword { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
    .hl-builtin { color: var(--vscode-symbolIcon-functionForeground, #4ec9b0); }
    .hl-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .hl-function { color: var(--vscode-symbolIcon-methodForeground, #dcdcaa); }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">Adacoder</div>
    <div class="header-actions">
      <button id="showOutputBtn" class="ghost">Output</button>
    </div>
  </div>

  <div class="tabs">
    <button id="taskTabBtn" class="tab-btn active">Task</button>
    <button id="settingsTabBtn" class="tab-btn">Settings</button>
  </div>

  <div id="taskPage" class="page active task-page">
    <div class="task-toolbar">
      <div class="task-toolbar-row">
        <label for="taskProfileSelect">Profile</label>
        <select id="taskProfileSelect"></select>
        <button id="newProfileFromTaskBtn" class="ghost">Add</button>
      </div>

    </div>

    <div id="logs" class="logs chat-stream"></div>

    <div class="composer">
      <textarea id="problemInput" placeholder="Ask anything about your code..."></textarea>
      <div class="composer-path-row">
        <input id="testPathInput" placeholder="test_file_path" />
        <button id="pickTestPathBtn" class="ghost">Browse</button>
      </div>
      <div class="composer-actions">
        <div id="statusText" class="status">Idle</div>
        <div class="actions">
          <button id="useSelectionBtn" class="ghost">Use Selection</button>
          <button id="runBtn">Run Workflow</button>
        </div>
      </div>
    </div>
  </div>

  <div id="settingsPage" class="page">
    <div class="section">
      <div class="row">
        <label for="settingsProfileSelect">Profiles</label>
        <select id="settingsProfileSelect"></select>
        <button id="newProfileBtn" class="ghost">New</button>
      </div>

      <div class="row">
        <label for="profileNameInput">Name</label>
        <input id="profileNameInput" placeholder="Profile name" />
      </div>

      <div class="row">
        <label for="profileBaseUrlInput">Base URL</label>
        <input id="profileBaseUrlInput" placeholder="https://..." />
      </div>

      <div class="row">
        <label for="profileModelInput">Model</label>
        <input id="profileModelInput" placeholder="gpt-5.4" />
      </div>

      <div class="row">
        <label for="profileProviderSelect">Provider</label>
        <select id="profileProviderSelect">
          <option value="openai">openai</option>
          <option value="claude">claude</option>
          <option value="other">other</option>
          <option value="ollama">ollama</option>
          <option value="vllm">vllm</option>
        </select>
      </div>

      <div class="row">
        <label for="profileApiKeyInput">API Key</label>
        <input id="profileApiKeyInput" type="password" placeholder="API key" />
      </div>

      <div class="actions">
        <button id="openProfileConfigBtn" class="ghost">Open Config File</button>
        <button id="reloadProfilesBtn" class="ghost">Reload</button>
        <button id="deleteProfileBtn" class="ghost">Delete</button>
        <button id="saveProfileBtn">Save Profile</button>
      </div>
      <div id="profileHint" class="hint"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const taskTabBtn = document.getElementById('taskTabBtn');
    const settingsTabBtn = document.getElementById('settingsTabBtn');
    const taskPage = document.getElementById('taskPage');
    const settingsPage = document.getElementById('settingsPage');

    const taskProfileSelect = document.getElementById('taskProfileSelect');
    const settingsProfileSelect = document.getElementById('settingsProfileSelect');
    const problemInput = document.getElementById('problemInput');
    const testPathInput = document.getElementById('testPathInput');
    const statusText = document.getElementById('statusText');
    const logs = document.getElementById('logs');

    const profileNameInput = document.getElementById('profileNameInput');
    const profileBaseUrlInput = document.getElementById('profileBaseUrlInput');
    const profileModelInput = document.getElementById('profileModelInput');
    const profileProviderSelect = document.getElementById('profileProviderSelect');
    const profileApiKeyInput = document.getElementById('profileApiKeyInput');
    const profileHint = document.getElementById('profileHint');

    const state = {
      profiles: [],
      activeProfileId: '',
      editingProfileId: '',
      running: false,
      returnToTaskAfterSave: false,
      loadingLog: null,
      taskCounter: 0,
      pendingTaskRequest: ''
    };

    const switchPage = (page) => {
      const isTask = page === 'task';
      taskPage.classList.toggle('active', isTask);
      settingsPage.classList.toggle('active', !isTask);
      taskTabBtn.classList.toggle('active', isTask);
      settingsTabBtn.classList.toggle('active', !isTask);
    };

    const findProfile = (id) => state.profiles.find((profile) => profile.id === id);

    const addLog = (text, className = 'info') => {
      const div = document.createElement('div');
      div.className = 'log ' + className;
      div.appendChild(renderMarkdownToFragment(text));
      logs.appendChild(div);
      logs.scrollTop = logs.scrollHeight;
      return div;
    };

    const addTaskSeparator = (taskNumber) => {
      const separator = document.createElement('div');
      separator.className = 'task-separator';
      const label = document.createElement('span');
      label.textContent = 'Task ' + taskNumber;
      separator.appendChild(label);
      logs.appendChild(separator);
      logs.scrollTop = logs.scrollHeight;
    };

    const escapeHtml = (value) => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

    const PYTHON_KEYWORDS = new Set([
      'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
      'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
      'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
    ]);

    const PYTHON_BUILTINS = new Set([
      'int', 'str', 'list', 'dict', 'set', 'tuple', 'float', 'bool', 'len', 'range', 'print',
      'enumerate', 'zip', 'map', 'filter', 'open', 'sum', 'min', 'max', 'any', 'all', 'type', 'isinstance'
    ]);

    const tokenizePython = (code) => {
      const tokenRegex = /("""[\\s\\S]*?"""|'''[\\s\\S]*?'''|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|#[^\\n]*|\\b[A-Za-z_][A-Za-z0-9_]*\\b|\\b\\d+(?:\\.\\d+)?\\b)/g;
      let out = '';
      let last = 0;
      for (const match of code.matchAll(tokenRegex)) {
        const token = match[0];
        const index = match.index ?? 0;
        out += escapeHtml(code.slice(last, index));

        if (token.startsWith('#')) {
          out += '<span class="hl-comment">' + escapeHtml(token) + '</span>';
        } else if (token.startsWith('"') || token.startsWith("'") ) {
          out += '<span class="hl-string">' + escapeHtml(token) + '</span>';
        } else if (/^\\d/.test(token)) {
          out += '<span class="hl-number">' + escapeHtml(token) + '</span>';
        } else if (PYTHON_KEYWORDS.has(token)) {
          out += '<span class="hl-keyword">' + escapeHtml(token) + '</span>';
        } else if (PYTHON_BUILTINS.has(token)) {
          out += '<span class="hl-builtin">' + escapeHtml(token) + '</span>';
        } else {
          const rest = code.slice(index + token.length);
          const isFunction = /^\\s*\\(/.test(rest);
          if (isFunction) {
            out += '<span class="hl-function">' + escapeHtml(token) + '</span>';
          } else {
            out += escapeHtml(token);
          }
        }

        last = index + token.length;
      }

      out += escapeHtml(code.slice(last));
      return out;
    };

    const createCodeBlockElement = (code, language = 'python') => {
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      const lang = String(language || '').toLowerCase();

      if (lang === 'python' || lang === 'py' || lang === '') {
        codeEl.className = 'language-python';
        codeEl.innerHTML = tokenizePython(code);
      } else {
        codeEl.className = 'language-' + lang;
        codeEl.textContent = code;
      }

      pre.appendChild(codeEl);
      return pre;
    };

    const mdFence = String.fromCharCode(96).repeat(3);

    const renderInlineMarkdown = (text) => {
      const escaped = escapeHtml(text);
      return escaped;
    };

    const renderMarkdownToFragment = (markdown) => {
      const fragment = document.createDocumentFragment();
      const lines = String(markdown ?? '').replaceAll('\\r\\n', '\\n').split('\\n');
      let paragraph = [];

      const flushParagraph = () => {
        if (paragraph.length === 0) {
          return;
        }
        const div = document.createElement('div');
        div.className = 'md-paragraph';
        div.innerHTML = renderInlineMarkdown(paragraph.join(' '));
        fragment.appendChild(div);
        paragraph = [];
      };

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith(mdFence)) {
          flushParagraph();
          const language = trimmed.slice(3).trim();
          const codeLines = [];
          i += 1;
          while (i < lines.length && !lines[i].trim().startsWith(mdFence)) {
            codeLines.push(lines[i]);
            i += 1;
          }
          fragment.appendChild(createCodeBlockElement(codeLines.join('\\n'), language));
          continue;
        }

        if (!trimmed) {
          flushParagraph();
          continue;
        }

        if (trimmed === '---' || trimmed === '***') {
          flushParagraph();
          const divider = document.createElement('div');
          divider.className = 'md-divider';
          fragment.appendChild(divider);
          continue;
        }

        if (trimmed.startsWith('### ')) {
          flushParagraph();
          const heading = document.createElement('div');
          heading.className = 'md-heading md-h3';
          heading.innerHTML = renderInlineMarkdown(trimmed.slice(4));
          fragment.appendChild(heading);
          continue;
        }

        if (trimmed.startsWith('## ')) {
          flushParagraph();
          const heading = document.createElement('div');
          heading.className = 'md-heading md-h2';
          heading.innerHTML = renderInlineMarkdown(trimmed.slice(3));
          fragment.appendChild(heading);
          continue;
        }

        if (trimmed.startsWith('# ')) {
          flushParagraph();
          const heading = document.createElement('div');
          heading.className = 'md-heading md-h1';
          heading.innerHTML = renderInlineMarkdown(trimmed.slice(2));
          fragment.appendChild(heading);
          continue;
        }

        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          flushParagraph();
          const list = document.createElement('ul');
          while (i < lines.length) {
            const current = lines[i].trim();
            if (!(current.startsWith('- ') || current.startsWith('* '))) {
              break;
            }
            const item = document.createElement('li');
            item.innerHTML = renderInlineMarkdown(current.slice(2));
            list.appendChild(item);
            i += 1;
          }
          i -= 1;
          fragment.appendChild(list);
          continue;
        }

        paragraph.push(trimmed);
      }

      flushParagraph();

      if (fragment.childNodes.length === 0) {
        const fallback = document.createElement('div');
        fallback.className = 'md-paragraph';
        fallback.textContent = '';
        fragment.appendChild(fallback);
      }

      return fragment;
    };

    const appendCodeBlock = (card, code, language = 'python') => {
      card.appendChild(createCodeBlockElement(code, language));
    };

    const showLoading = () => {
      if (state.loadingLog) {
        return;
      }
      state.loadingLog = addLog('Loading...', 'loading');
    };

    const hideLoading = () => {
      if (!state.loadingLog) {
        return;
      }
      state.loadingLog.remove();
      state.loadingLog = null;
    };

    const clearTaskInputs = () => {
      problemInput.value = '';
      testPathInput.value = '';
    };

    const pushField = (parts, label, value) => {
      if (value === undefined || value === null) {
        return;
      }
      const text = String(value).trim();
      if (!text || text === 'null' || text === 'undefined') {
        return;
      }
      parts.push(label + ': ' + text);
    };

    const formatTaskRequest = (problem, testFilePath, profileId) => {
      const parts = ['### User Request'];
      const prompt = String(problem ?? '').trim();
      const path = String(testFilePath ?? '').trim();

      if (prompt) {
        parts.push('- Prompt:');
        parts.push(prompt);
      } else {
        parts.push('- Prompt: (empty)');
      }

      if (path) {
        parts.push('- Test File: ' + path);
      }

      const profile = findProfile(profileId);
      if (profile && typeof profile.name === 'string' && profile.name.trim()) {
        parts.push('- Profile: ' + profile.name.trim());
      }

      return parts.join('\\n');
    };

    const formatSuccessResult = (result, passed) => {
      const parts = ['### Result', '- Status: ' + (passed ? 'passed' : 'failed')];

      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return parts.join('\\n');
      }

      const topFields = [];
      pushField(topFields, 'Stage', result.stage);
      pushField(topFields, 'Message', result.message);
      for (const field of topFields) {
        parts.push('- ' + field);
      }

      const testResult = result.code_test_res_dict;
      if (testResult && typeof testResult === 'object' && !Array.isArray(testResult)) {
        const testParts = [];
        if (typeof testResult.passed === 'boolean') {
          testParts.push('Passed: ' + (testResult.passed ? 'true' : 'false'));
        }
        pushField(testParts, 'Stage', testResult.stage);
        pushField(testParts, 'Error Type', testResult.error_type ?? testResult.errorType ?? testResult.type);
        pushField(testParts, 'Error', testResult.error);
        pushField(testParts, 'Traceback', testResult.traceback);

        if (testParts.length > 0) {
          parts.push('- Test Result:');
          for (const line of testParts) {
            parts.push('  - ' + line);
          }
        }
      }

      return parts.join('\\n');
    };

    const formatFailureReason = (data) => {
      const reason = typeof data.failureReason === 'string' ? data.failureReason.trim() : '';
      const isRetryExhausted = /(?:after\\s*10\\s*attempts?|10\\s*attempts?)/i.test(reason);
      if (reason && isRetryExhausted) {
        return ['### Failure', '- Error: ' + reason].join('\\n');
      }

      const result = data.result;
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const error = [result.error, result.reason, result.message, reason].find((item) => typeof item === 'string' && item.trim());
        const errorType = [result.type, result.errorType, result.error_type, result.exception_type, result.exception].find((item) => typeof item === 'string' && item.trim());
        const traceback = [result.traceback, result.stack, result.stderr].find((item) => typeof item === 'string' && item.trim());

        const parts = ['### Failure'];
        if (typeof error === 'string' && error.trim()) {
          parts.push('- Error: ' + error.trim());
        }
        if (typeof errorType === 'string' && errorType.trim()) {
          parts.push('- Type: ' + errorType.trim());
        }
        if (typeof traceback === 'string' && traceback.trim()) {
          parts.push('- Traceback:');
          parts.push(traceback.trim());
        }

        if (parts.length > 1) {
          return parts.join('\\n');
        }
      }

      if (reason) {
        return ['### Failure', '- Error: ' + reason].join('\\n');
      }

      return ['### Failure', '- Error: Workflow failed without a detailed reason.'].join('\\n');
    };

    const setRunning = (running) => {
      const wasRunning = state.running;
      state.running = running;
      document.getElementById('runBtn').disabled = running;
      statusText.textContent = running ? 'Loading...' : 'Idle';

      if (running && !wasRunning) {
        state.taskCounter += 1;
        addTaskSeparator(state.taskCounter);
        if (state.pendingTaskRequest) {
          addLog(state.pendingTaskRequest, 'user-request');
          state.pendingTaskRequest = '';
        }
      }

      if (running) {
        showLoading();
      } else {
        hideLoading();
      }
    };

    const renderProfileOptions = () => {
      const currentTask = taskProfileSelect.value;
      const currentSettings = settingsProfileSelect.value;

      taskProfileSelect.innerHTML = '';
      settingsProfileSelect.innerHTML = '';

      state.profiles.forEach((profile) => {
        const taskOption = document.createElement('option');
        taskOption.value = profile.id;
        taskOption.textContent = profile.name + ' (' + profile.provider + ')';
        taskProfileSelect.appendChild(taskOption);

        const settingsOption = document.createElement('option');
        settingsOption.value = profile.id;
        settingsOption.textContent = profile.name;
        settingsProfileSelect.appendChild(settingsOption);
      });

      const active = state.activeProfileId || state.profiles[0]?.id || '';
      taskProfileSelect.value = state.profiles.some((p) => p.id === currentTask) ? currentTask : active;
      settingsProfileSelect.value = state.profiles.some((p) => p.id === currentSettings) ? currentSettings : active;
    };

    const loadProfileEditor = () => {
      if (!state.editingProfileId) {
        profileNameInput.value = 'New Profile';
        profileBaseUrlInput.value = '';
        profileModelInput.value = 'gpt-5.4';
        profileProviderSelect.value = 'other';
        profileApiKeyInput.value = '';
        profileHint.textContent = 'Create a new profile and save it.';
        return;
      }

      const profile = findProfile(state.editingProfileId);
      if (!profile) {
        profileNameInput.value = '';
        profileBaseUrlInput.value = '';
        profileModelInput.value = 'gpt-5.4';
        profileProviderSelect.value = 'other';
        profileApiKeyInput.value = '';
        profileHint.textContent = 'Selected profile not found.';
        return;
      }

      profileNameInput.value = profile.name;
      profileBaseUrlInput.value = profile.baseUrl;
      profileModelInput.value = profile.model;
      profileProviderSelect.value = profile.provider || 'other';
      profileApiKeyInput.value = profile.apiKey;
      profileHint.textContent = profile.apiKey ? 'API key is set for this profile.' : 'API key is empty for this profile.';
    };

    const startNewProfile = (returnToTask) => {
      state.editingProfileId = '';
      state.returnToTaskAfterSave = returnToTask;
      loadProfileEditor();
      switchPage('settings');
    };

    taskTabBtn.addEventListener('click', () => switchPage('task'));
    settingsTabBtn.addEventListener('click', () => switchPage('settings'));

    document.getElementById('showOutputBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'showOutput' });
    });

    taskProfileSelect.addEventListener('change', () => {
      const profileId = taskProfileSelect.value;
      state.activeProfileId = profileId;
      vscode.postMessage({ type: 'switchProfile', profileId });
    });

    settingsProfileSelect.addEventListener('change', () => {
      state.editingProfileId = settingsProfileSelect.value;
      loadProfileEditor();
    });

    document.getElementById('newProfileFromTaskBtn').addEventListener('click', () => {
      startNewProfile(true);
    });

    document.getElementById('newProfileBtn').addEventListener('click', () => {
      startNewProfile(false);
    });

    document.getElementById('openProfileConfigBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openProfileConfig' });
    });

    document.getElementById('reloadProfilesBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'reloadProfiles' });
    });

    document.getElementById('saveProfileBtn').addEventListener('click', () => {
      vscode.postMessage({
        type: 'saveProfile',
        id: state.editingProfileId,
        name: profileNameInput.value,
        baseUrl: profileBaseUrlInput.value,
        model: profileModelInput.value,
        provider: profileProviderSelect.value,
        apiKey: profileApiKeyInput.value
      });
      if (state.returnToTaskAfterSave) {
        switchPage('task');
        state.returnToTaskAfterSave = false;
      }
    });

    document.getElementById('deleteProfileBtn').addEventListener('click', () => {
      if (!state.editingProfileId) {
        addLog('No profile selected for deletion.', 'error');
        return;
      }
      vscode.postMessage({
        type: 'deleteProfile',
        id: state.editingProfileId
      });
    });

    document.getElementById('pickTestPathBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'selectTestFile' });
    });

    document.getElementById('useSelectionBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'useEditorSelection' });
    });

    document.getElementById('runBtn').addEventListener('click', () => {
      const problem = problemInput.value;
      const testFilePath = testPathInput.value;
      const profileId = taskProfileSelect.value;
      state.pendingTaskRequest = formatTaskRequest(problem, testFilePath, profileId);

      vscode.postMessage({
        type: 'runWorkflow',
        problem,
        testFilePath
      });
    });

    problemInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!state.running) {
          document.getElementById('runBtn').click();
        }
      }
    });

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || typeof data.type !== 'string') {
        return;
      }

      switch (data.type) {
        case 'switchPage':
          if (data.page === 'settings') {
            switchPage('settings');
          } else {
            switchPage('task');
          }
          break;
        case 'state': {
          state.profiles = Array.isArray(data.profiles) ? data.profiles : [];
          state.activeProfileId = typeof data.activeProfileId === 'string' ? data.activeProfileId : '';
          renderProfileOptions();

          if (!state.editingProfileId || !findProfile(state.editingProfileId)) {
            state.editingProfileId = state.activeProfileId || (state.profiles[0]?.id || '');
          }
          loadProfileEditor();
          break;
        }
        case 'prefillProblem':
          if (typeof data.problem === 'string') {
            problemInput.value = data.problem;
          }
          break;
        case 'setTestPath':
          if (typeof data.testFilePath === 'string') {
            testPathInput.value = data.testFilePath;
          }
          break;
        case 'runState':
          setRunning(Boolean(data.running));
          break;
        case 'log':
          if (typeof data.text === 'string') {
            const level = typeof data.level === 'string' ? data.level : 'info';
            addLog(data.text, level);
          }
          break;
        case 'workflowError': {
          hideLoading();
          clearTaskInputs();
          const reason = typeof data.reason === 'string' && data.reason.trim()
            ? data.reason.trim()
            : 'Workflow failed without a detailed reason.';
          addLog(['### Failure', '- Error: ' + reason].join('\\n'), 'result-fail');
          break;
        }
        case 'workflowResult': {
          hideLoading();
          clearTaskInputs();
          const passed = Boolean(data.passed);

          if (!passed) {
            addLog(formatFailureReason(data), 'result-fail');
            break;
          }

          addLog(formatSuccessResult(data.result, passed), 'result-pass');

          if (typeof data.code === 'string' && data.code.trim()) {
            addLog(['### Code', mdFence + 'python', data.code, mdFence].join('\\n'), 'code-block');
          }
          break;
        }
        default:
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
