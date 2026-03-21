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

interface BridgeLogEvent {
	level: BridgeLogLevel;
	text: string;
}

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
		this.appendUiLog('info', `Running with profile: ${profile.name}`);
		this.appendUiLog('info', `test_file_path: ${testFilePath}`);

		try {
			const args: WorkflowArgs = {
				base_url: profile.baseUrl,
				api_key: profile.apiKey,
				model: profile.model,
				provider: profile.provider,
				problem,
				test_file_path: testFilePath
			};

			const response = await invokeBridge(context, args, this.outputChannel, (event) => {
				this.appendUiLog(event.level, event.text);
			});

			if (!response.ok) {
				const detail = response.traceback ? `\n${response.traceback}` : '';
				this.appendUiLog('error', `Backend error: ${response.error ?? 'Unknown error'}${detail}`);
				return;
			}

			const result = response.result as WorkflowResult | undefined;
			const passed = Boolean(result?.passed);
			const generatedCode = typeof result?.code === 'string' ? result.code : '';
			this.postMessage({
				type: 'workflowResult',
				passed,
				result,
				code: generatedCode
			});
			this.appendUiLog('info', passed ? 'Workflow completed and tests passed.' : 'Workflow completed but tests failed.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.appendUiLog('error', `Execution failed: ${message}`);
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
		await panel.runWorkflow(context, {
			problem: selection,
			testFilePath
		});
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
	outputChannel: vscode.OutputChannel,
	onLog: (event: BridgeLogEvent) => void
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

		onLog({ level: 'runtime', text: `python=${pythonPath}` });
		onLog({ level: 'runtime', text: `bridge=${bridgePath}` });
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
			onLog({ level: 'stderr', text });
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
					onLog({ level: 'stdout', text: line });
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
				onLog({ level: 'stdout', text: line });
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
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 360px;
      overflow: auto;
    }
    .log {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 7px 9px;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
    }
    .log.runtime { color: var(--muted); }
    .log.stderr, .log.error { border-color: var(--error); color: var(--error); }
    .log.result-pass { border-color: var(--ok); }
    .log.result-fail { border-color: var(--warn); }
    .hint { font-size: 12px; color: var(--muted); }
    pre {
      margin: 8px 0 0;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      overflow: auto;
      max-height: 220px;
      background: var(--input-bg);
    }
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

  <div id="taskPage" class="page active">
    <div class="section">
      <div class="row">
        <label for="taskProfileSelect">Profile</label>
        <select id="taskProfileSelect"></select>
        <button id="newProfileFromTaskBtn" class="ghost">Add</button>
      </div>

      <textarea id="problemInput" placeholder="Describe the problem here..."></textarea>

      <div class="path-row">
        <input id="testPathInput" placeholder="test_file_path" />
        <button id="pickTestPathBtn" class="ghost">Browse</button>
      </div>

      <div class="actions">
        <button id="useSelectionBtn" class="ghost">Use Selection</button>
        <button id="runBtn">Run Workflow</button>
      </div>
      <div id="statusText" class="status">Idle</div>
    </div>

    <div id="logs" class="logs"></div>
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
      returnToTaskAfterSave: false
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
      div.textContent = text;
      logs.appendChild(div);
      logs.scrollTop = logs.scrollHeight;
      return div;
    };

    const setRunning = (running) => {
      state.running = running;
      document.getElementById('runBtn').disabled = running;
      statusText.textContent = running ? 'Running...' : 'Idle';
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
      vscode.postMessage({
        type: 'runWorkflow',
        problem: problemInput.value,
        testFilePath: testPathInput.value
      });
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
        case 'workflowResult': {
          const passed = Boolean(data.passed);
          const title = passed ? 'Result: tests passed' : 'Result: tests failed';
          const card = addLog(title, passed ? 'result-pass' : 'result-fail');

          if (data.result) {
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(data.result, null, 2);
            card.appendChild(pre);
          }

          if (typeof data.code === 'string' && data.code.trim()) {
            const openBtn = document.createElement('button');
            openBtn.textContent = 'Open Generated Code';
            openBtn.addEventListener('click', () => {
              vscode.postMessage({ type: 'openGeneratedCode', code: data.code });
            });
            card.appendChild(openBtn);
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
