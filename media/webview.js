(function () {
  const vscode = acquireVsCodeApi();

  const taskPage = document.getElementById('taskPage');
  const settingsPage = document.getElementById('settingsPage');
  const showOutputBtn = document.getElementById('showOutputBtn');
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  const backToWorkflowBtn = document.getElementById('backToWorkflowBtn');

  const taskProfileSelect = document.getElementById('taskProfileSelect');
  const settingsProfileSelect = document.getElementById('settingsProfileSelect');
  const problemInput = document.getElementById('problemInput');
  const testInput = document.getElementById('testInput');
  const testModeSelect = document.getElementById('testModeSelect');
  const modelSummary = document.getElementById('modelSummary');
  const testsSummary = document.getElementById('testsSummary');
  const executionModeSelect = document.getElementById('executionModeSelect');
  const contextEnabledInput = document.getElementById('contextEnabledInput');
  const composerStatus = document.getElementById('composerStatus');
  const resumeWorkflowBtn = document.getElementById('resumeWorkflowBtn');
  const interruptWorkflowBtn = document.getElementById('interruptWorkflowBtn');
  const conversationScroll = document.getElementById('conversationScroll');
  const timeline = document.getElementById('timeline');

  const manualTestsSection = document.getElementById('manualTestsSection');
  const testsWorkspaceSection = document.getElementById('testsWorkspaceSection');
  const resolvedTestsHint = document.getElementById('resolvedTestsHint');
  const resolvedTestsEditor = document.getElementById('resolvedTestsEditor');
  const generateTestsBtn = document.getElementById('generateTestsBtn');
  const saveResolvedTestsBtn = document.getElementById('saveResolvedTestsBtn');

  const useSelectionForProblemBtn = document.getElementById('useSelectionForProblemBtn');
  const useSelectionForTestsBtn = document.getElementById('useSelectionForTestsBtn');
  const clearSessionBtn = document.getElementById('clearSessionBtn');
  const submitWorkflowBtn = document.getElementById('submitWorkflowBtn');

  const profileNameInput = document.getElementById('profileNameInput');
  const profileBaseUrlInput = document.getElementById('profileBaseUrlInput');
  const profileModelInput = document.getElementById('profileModelInput');
  const profileProviderSelect = document.getElementById('profileProviderSelect');
  const profileApiKeyInput = document.getElementById('profileApiKeyInput');
  const profileHint = document.getElementById('profileHint');
  const newProfileBtn = document.getElementById('newProfileBtn');
  const openProfileConfigBtn = document.getElementById('openProfileConfigBtn');
  const reloadProfilesBtn = document.getElementById('reloadProfilesBtn');
  const deleteProfileBtn = document.getElementById('deleteProfileBtn');
  const saveProfileBtn = document.getElementById('saveProfileBtn');

  const state = {
    profiles: [],
    activeProfileId: '',
    editingProfileId: '',
    session: null,
    running: false,
    runningLabel: '',
    localLogs: [],
    resolvedTestsDirty: false,
    lastSessionId: '',
    returnToTaskAfterSave: false,
    workflowMode: 'auto',
    interactiveState: 'idle',
    canResume: false,
    resumeLabel: '',
    interruptRequested: false,
    editablePlanEventId: '',
    editablePlanText: '',
    editingPlanSource: false,
    autoScrollPinned: true,
    lastTimelineSignature: ''
  };

  function isNearConversationBottom() {
    if (!conversationScroll) {
      return true;
    }
    return conversationScroll.scrollTop + conversationScroll.clientHeight >= conversationScroll.scrollHeight - 72;
  }

  function scrollConversationToBottom() {
    if (conversationScroll) {
      conversationScroll.scrollTop = conversationScroll.scrollHeight;
    }
    const pageHeight = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    window.scrollTo(0, pageHeight);
  }

  function requestConversationAutoScroll() {
    scrollConversationToBottom();
    requestAnimationFrame(function () {
      scrollConversationToBottom();
      requestAnimationFrame(scrollConversationToBottom);
    });
    window.setTimeout(scrollConversationToBottom, 80);
  }

  function switchPage(page) {
    const isTask = page === 'task';
    taskPage.classList.toggle('active', isTask);
    settingsPage.classList.toggle('active', !isTask);
  }

  function updateTestInputPlaceholder() {
    if (testInput) {
      testInput.dataset.placeholder = 'Paste runnable Python assert tests here.';
    }
    if (resolvedTestsEditor) {
      resolvedTestsEditor.dataset.placeholder = 'Generated assert tests appear here. Edit directly in this Python block.';
    }
  }

  function editableCodeText(element) {
    return element ? String(element.textContent || '') : '';
  }

  function highlightEditableCode(element) {
    if (!element || document.activeElement === element || !window.hljs) {
      return;
    }
    element.removeAttribute('data-highlighted');
    window.hljs.highlightElement(element);
  }

  function setEditableCodeText(element, code) {
    if (!element) {
      return;
    }
    element.textContent = String(code || '');
    highlightEditableCode(element);
  }

  function prepareEditableCodeForInput(element) {
    if (!element) {
      return;
    }
    element.textContent = editableCodeText(element);
  }

  function selectedTestText() {
    return testModeSelect.value === 'generate' ? '' : editableCodeText(testInput);
  }

  function selectedResolvedTestCode() {
    return testModeSelect.value === 'generate' ? editableCodeText(resolvedTestsEditor) : undefined;
  }

  function makeTimestamp() {
    return new Date().toISOString();
  }

  function addLocalLog(title, message, status) {
    state.localLogs.push({
      id: 'local-' + state.localLogs.length + '-' + Date.now(),
      stage: 'client',
      status: status || 'ready',
      title,
      message,
      created_at: makeTimestamp(),
      data: {}
    });
    renderTimeline();
  }

  function findProfile(id) {
    return state.profiles.find((profile) => profile.id === id);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function normalizeLanguage(language) {
    const normalized = String(language || '').trim().toLowerCase();
    if (!normalized) {
      return 'text';
    }
    if (normalized === 'py') {
      return 'python';
    }
    if (normalized === 'plaintext' || normalized === 'txt') {
      return 'text';
    }
    return normalized;
  }

  function highlightWithLibrary(code, language) {
    const normalizedLanguage = normalizeLanguage(language);
    if (window.hljs && normalizedLanguage !== 'text') {
      try {
        if (window.hljs.getLanguage(normalizedLanguage)) {
          return window.hljs.highlight(String(code || ''), { language: normalizedLanguage }).value;
        }
        return window.hljs.highlightAuto(String(code || '')).value;
      } catch (_error) {
        return escapeHtml(code);
      }
    }
    return escapeHtml(code);
  }

  function markdownRenderer() {
    if (!window.markdownit) {
      return null;
    }
    const md = window.markdownit({
      breaks: false,
      html: false,
      linkify: true
    });
    md.renderer.rules.fence = function (tokens, index) {
      const token = tokens[index];
      const language = normalizeLanguage(token.info || 'text');
      const highlighted = highlightWithLibrary(token.content, language);
      return [
        '<div class="code-shell">',
        '<div class="code-toolbar"><div class="code-language">',
        escapeHtml(language),
        '</div></div>',
        '<pre class="code-block hljs"><code class="language-',
        escapeHtml(language),
        '">',
        highlighted,
        '</code></pre>',
        '</div>'
      ].join('');
    };
    return md;
  }

  const md = markdownRenderer();

  function renderMarkdown(text) {
    const root = document.createElement('div');
    root.className = 'markdown';
    if (!md) {
      root.textContent = String(text || '');
      return root;
    }
    root.innerHTML = md.render(String(text || ''));
    root.querySelectorAll('a[href]').forEach(function (link) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer noopener');
    });
    return root;
  }

  function renderEditableMarkdown(text, onInput) {
    const shell = document.createElement('div');
    shell.className = 'editable-code-shell markdown-source-shell';

    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    const languageLabel = document.createElement('div');
    languageLabel.className = 'code-language';
    languageLabel.textContent = 'markdown';
    toolbar.appendChild(languageLabel);

    const pre = document.createElement('pre');
    pre.className = 'code-block hljs editable-code-block';
    const code = document.createElement('code');
    code.className = 'language-markdown editable-code';
    code.contentEditable = state.running ? 'false' : 'true';
    code.spellcheck = false;
    code.dataset.placeholder = 'Edit the markdown plan here.';
    setEditableCodeText(code, text);
    code.addEventListener('focus', function () {
      prepareEditableCodeForInput(code);
    });
    code.addEventListener('blur', function () {
      highlightEditableCode(code);
    });
    code.addEventListener('input', function () {
      onInput(editableCodeText(code).trim());
    });

    pre.appendChild(code);
    shell.appendChild(toolbar);
    shell.appendChild(pre);
    return shell;
  }

  function createBadge(text, className) {
    const badge = document.createElement('span');
    badge.className = 'badge ' + (className || '');
    badge.textContent = text;
    return badge;
  }

  function cardKindLabel(kind) {
    switch (kind) {
      case 'prompt':
        return 'Requirement';
      case 'code':
        return 'Code';
      case 'result':
        return 'Run Result';
      case 'plan':
        return 'Plan';
      case 'tests':
        return 'Tests';
      default:
        return 'Note';
    }
  }

  function createButton(label, className, onClick, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ' + (className || '');
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.addEventListener('click', onClick);
    return button;
  }

  function createCardFrame(kind, event) {
    const card = document.createElement('article');
    card.className = 'timeline-card conversation-card ' + kind + ' ' + ((event && event.status) || 'ready');
    card.dataset.kind = kind;

    const top = document.createElement('div');
    top.className = 'timeline-top';

    const titleWrap = document.createElement('div');
    const kindRow = document.createElement('div');
    kindRow.className = 'timeline-kind-row';
    kindRow.appendChild(createBadge(cardKindLabel(kind), 'kind-badge kind-' + kind));

    const title = document.createElement('div');
    title.className = 'timeline-title';
    title.textContent = (event && event.title) || kind;

    const meta = document.createElement('div');
    meta.className = 'timeline-meta';
    if (event && event.stage) {
      meta.appendChild(createBadge(String(event.stage).replaceAll('_', ' '), 'stage-badge stage-' + String(event.stage)));
    }
    if (event && event.status) {
      meta.appendChild(createBadge(String(event.status), 'status-badge status-' + String(event.status)));
    }
    titleWrap.appendChild(kindRow);
    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    const time = document.createElement('div');
    time.className = 'muted';
    time.textContent = new Date((event && event.created_at) || Date.now()).toLocaleTimeString();

    top.appendChild(titleWrap);
    top.appendChild(time);
    card.appendChild(top);

    return card;
  }

  function createActionRow() {
    const row = document.createElement('div');
    row.className = 'action-row card-actions';
    return row;
  }

  function renderFencedCodeMarkdown(code, language, options) {
    const fenced = ['```' + normalizeLanguage(language), String(code || ''), '```'].join('\n');
    const root = renderMarkdown(fenced);
    const actions = options && Array.isArray(options.actions) ? options.actions : [];
    if (actions.length > 0) {
      const shell = root.querySelector('.code-shell');
      const toolbar = shell ? shell.querySelector('.code-toolbar') : null;
      if (toolbar) {
        const actionsWrap = document.createElement('div');
        actionsWrap.className = 'code-toolbar-actions';
        actions.forEach(function (action) {
          actionsWrap.appendChild(createButton(
            action.label,
            action.className || 'secondary code-action',
            action.onClick,
            action.disabled
          ));
        });
        toolbar.appendChild(actionsWrap);
      }
    }
    return root;
  }

  function refreshEditableCodeBlocks() {
    highlightEditableCode(testInput);
    highlightEditableCode(resolvedTestsEditor);
  }

  function currentActionPayload() {
    return {
      problem: problemInput.value,
      testText: selectedTestText(),
      testMode: testModeSelect.value === 'generate' ? 'generate' : 'manual',
      resolvedTestCode: selectedResolvedTestCode(),
      contextEnabled: Boolean(contextEnabledInput.checked),
      maxRounds: 10,
      executionMode: executionModeSelect.value === 'continue' ? 'continue' : 'auto'
    };
  }

  function isInteractiveSelected() {
    return executionModeSelect.value === 'continue';
  }

  function sortedSessionEvents() {
    const sessionEvents = state.session && Array.isArray(state.session.events) ? state.session.events.slice() : [];
    return sessionEvents.sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')));
  }

  function getPlanText(event, fallback) {
    const plan = event && event.data && typeof event.data.plan === 'string' ? event.data.plan.trim() : '';
    if (plan) {
      return plan;
    }
    return fallback || '';
  }

  function latestPlanEvent(events) {
    const planEvents = events.filter((event) => {
      const plan = getPlanText(event, '');
      return event.stage === 'plan' && (event.status === 'completed' || event.status === 'ready') && Boolean(plan);
    });
    return planEvents.length > 0 ? planEvents[planEvents.length - 1] : null;
  }

  function latestFailedEvaluateEvent(events) {
    const failed = events.filter((event) => event.stage === 'evaluate' && event.status === 'failed');
    return failed.length > 0 ? failed[failed.length - 1] : null;
  }

  function latestEvaluateEvent(events) {
    const evaluateEvents = events.filter((event) => event.stage === 'evaluate' && (event.status === 'completed' || event.status === 'failed'));
    return evaluateEvents.length > 0 ? evaluateEvents[evaluateEvents.length - 1] : null;
  }

  function syncEditablePlanDraft() {
    const events = sortedSessionEvents();
    const latestPlan = latestPlanEvent(events);
    const latestPlanId = latestPlan ? latestPlan.id : '';
    const latestPlanText = latestPlan ? getPlanText(latestPlan, state.session ? state.session.current_plan || '' : '') : '';

    if (state.interactiveState !== 'await_plan') {
      state.editablePlanEventId = '';
      state.editablePlanText = '';
      state.editingPlanSource = false;
      return;
    }

    if (latestPlanId !== state.editablePlanEventId) {
      state.editablePlanEventId = latestPlanId;
      state.editablePlanText = latestPlanText;
      state.editingPlanSource = false;
    }
  }

  function renderPromptCard() {
    if (!state.session || !state.session.problem_statement) {
      return null;
    }

    const card = createCardFrame('prompt', {
      title: 'Requirement',
      stage: 'prompt',
      status: 'ready',
      created_at: state.session.created_at
    });
    card.classList.add('user-card');
    card.appendChild(renderMarkdown(state.session.problem_statement));

    if (state.session.test_text && state.session.test_mode !== 'generate') {
      const details = document.createElement('div');
      details.className = 'card-subsection';
      const label = document.createElement('div');
      label.className = 'mini-heading';
      label.textContent = 'Tests';
      details.appendChild(label);
      details.appendChild(renderFencedCodeMarkdown(state.session.test_text, 'python'));
      card.appendChild(details);
    }

    return card;
  }

  function renderCodeCard(event, code) {
    const card = createCardFrame('code', event);
    card.appendChild(renderFencedCodeMarkdown(code, 'python', {
      actions: [
        {
          label: 'Open',
          className: 'secondary code-action',
          onClick: function () {
            vscode.postMessage({
              type: 'openGeneratedCode',
              code
            });
          },
          disabled: state.running
        },
        {
          label: 'Insert',
          className: 'code-action',
          onClick: function () {
            vscode.postMessage({
              type: 'insertGeneratedCode',
              code
            });
          },
          disabled: state.running
        }
      ]
    }));
    return card;
  }

  function renderResultCard(event, isLatestEvaluate, isLatestFailed) {
    const card = createCardFrame('result', event);
    const evaluation = event.data && typeof event.data.evaluation === 'object' ? event.data.evaluation : {};
    const summary = document.createElement('div');
    summary.className = 'result-summary';

    function appendResultLine(markdown, className) {
      const line = renderMarkdown(markdown);
      line.classList.add('result-line');
      if (className) {
        line.classList.add(className);
      }
      summary.appendChild(line);
    }

    const passed = evaluation && evaluation.passed === true;
    const failed = event.status === 'failed' || (evaluation && evaluation.passed === false);

    if (event.message) {
      appendResultLine(event.message, passed ? 'passed' : failed ? 'failed' : '');
    }
    if (evaluation && typeof evaluation.stage === 'string' && evaluation.stage) {
      appendResultLine('**Stage:** `' + evaluation.stage + '`', 'muted-line');
    }
    if (evaluation && typeof evaluation.error_type === 'string' && evaluation.error_type) {
      appendResultLine('**Error Type:** `' + evaluation.error_type + '`', 'failed');
    }
    if (evaluation && typeof evaluation.error === 'string' && evaluation.error) {
      appendResultLine('**Error:** ' + evaluation.error, 'failed');
    }
    if (evaluation && typeof evaluation.passed === 'boolean') {
      appendResultLine('**Passed:** ' + (evaluation.passed ? 'yes' : 'no'), evaluation.passed ? 'passed' : 'failed');
    }

    if (summary.childNodes.length > 0) {
      card.appendChild(summary);
    }

    if (evaluation && typeof evaluation.traceback === 'string' && evaluation.traceback.trim()) {
      const trace = document.createElement('div');
      trace.className = 'card-subsection';
      const label = document.createElement('div');
      label.className = 'mini-heading';
      label.textContent = 'Traceback';
      trace.appendChild(label);
      trace.appendChild(renderFencedCodeMarkdown(evaluation.traceback.trim(), 'text'));
      card.appendChild(trace);
    }

    if (isLatestFailed && state.workflowMode === 'continue' && isInteractiveSelected()) {
      const row = createActionRow();
      row.appendChild(createButton('Next Step', '', function () {
        vscode.postMessage(Object.assign({ type: 'continueWithFeedback' }, currentActionPayload()));
      }, state.running));
      row.appendChild(createButton('Restart From Prompt', 'secondary', function () {
        vscode.postMessage(Object.assign({ type: 'restartInteractiveWorkflow' }, currentActionPayload()));
      }, state.running));
      row.appendChild(createButton('End Here', 'subtle', function () {
        vscode.postMessage({ type: 'stopInteractiveWorkflow' });
      }, state.running));
      card.appendChild(row);
    }

    if (!isLatestFailed && isLatestEvaluate && evaluation && evaluation.passed === true && state.session && state.session.passed) {
      const row = createActionRow();
      row.appendChild(createButton('Insert Latest Code', '', function () {
        if (!state.session || !state.session.current_code) {
          return;
        }
        vscode.postMessage({
          type: 'insertGeneratedCode',
          code: state.session.current_code
        });
      }, state.running || !state.session || !state.session.current_code));
      row.appendChild(createButton('Restart From Prompt', 'secondary', function () {
        vscode.postMessage(Object.assign({ type: 'restartInteractiveWorkflow' }, currentActionPayload()));
      }, state.running));
      row.appendChild(createButton('End Here', 'subtle', function () {
        vscode.postMessage({ type: 'stopInteractiveWorkflow' });
      }, state.running));
      card.appendChild(row);
    }

    return card;
  }

  function renderPlanCard(event, plan, editable) {
    const card = createCardFrame('plan', event);

    if (!editable) {
      card.appendChild(renderMarkdown(plan));
      return card;
    }

    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'Interactive mode paused here. Edit this plan, regenerate it from the latest failure, or move to the next step from this card.';
    card.appendChild(note);

    if (state.editingPlanSource) {
      card.appendChild(renderEditableMarkdown(state.editablePlanText || plan, function (value) {
        state.editablePlanText = value;
      }));
    } else {
      const preview = document.createElement('div');
      preview.className = 'plan-preview';
      preview.title = 'Click to edit the markdown source.';
      preview.appendChild(renderMarkdown(state.editablePlanText || plan));
      preview.addEventListener('click', function () {
        if (state.running) {
          return;
        }
        state.editingPlanSource = true;
        renderTimeline();
      });
      card.appendChild(preview);
    }

    const row = createActionRow();
    row.appendChild(createButton(state.editingPlanSource ? 'Preview Plan' : 'Edit Markdown', 'secondary', function () {
      state.editingPlanSource = !state.editingPlanSource;
      renderTimeline();
    }, state.running));
    row.appendChild(createButton('Save Plan', 'secondary', function () {
      state.editingPlanSource = false;
      renderTimeline();
      vscode.postMessage({
        type: 'updateWorkflowPlan',
        plan: state.editablePlanText
      });
    }, state.running));
    row.appendChild(createButton('Regenerate Plan', 'secondary', function () {
      vscode.postMessage(Object.assign({ type: 'continueWithFeedback' }, currentActionPayload()));
    }, state.running));
    row.appendChild(createButton('Next Step', '', function () {
      vscode.postMessage(Object.assign({
        type: 'continueWithPlan',
        planOverride: state.editablePlanText
      }, currentActionPayload()));
    }, state.running));
    row.appendChild(createButton('End Here', 'subtle', function () {
      vscode.postMessage({ type: 'stopInteractiveWorkflow' });
    }, state.running));
    card.appendChild(row);

    return card;
  }

  function renderTestsCard(event, testCode) {
    const card = createCardFrame('tests', event);
    card.appendChild(renderFencedCodeMarkdown(testCode, 'python'));
    return card;
  }

  function renderNoteCard(event) {
    const card = createCardFrame('note', event);
    card.classList.add('note-card');
    card.appendChild(renderMarkdown(event.message || ''));
    return card;
  }

  function conversationEntries() {
    const entries = [];
    if (state.session && state.session.problem_statement) {
      entries.push({
        kind: 'prompt',
        id: 'prompt-' + state.session.session_id
      });
    }

    const events = sortedSessionEvents();
    const latestPlan = latestPlanEvent(events);
    const latestFailedEval = latestFailedEvaluateEvent(events);
    const latestEvaluate = latestEvaluateEvent(events);

    events.forEach((event) => {
      if (event.stage === 'tests') {
        return;
      }

      const data = event.data || {};
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      const testCode = typeof data.test_code === 'string' ? data.test_code.trim() : '';
      const plan = getPlanText(event, '');
      const isPlanEvent = event.stage === 'plan' && (event.status === 'completed' || event.status === 'ready') && Boolean(plan);
      const isCodeEvent = (event.stage === 'generate' || event.stage === 'regenerate' || event.stage === 'debug_fix')
        && event.status === 'completed'
        && Boolean(code);
      const isTestsEvent = event.stage === 'tests'
        && (event.status === 'completed' || event.status === 'ready')
        && Boolean(testCode);
      const isResultEvent = event.stage === 'evaluate' && (event.status === 'completed' || event.status === 'failed');

      if (isCodeEvent) {
        entries.push({
          kind: 'code',
          id: event.id,
          event,
          code
        });
        return;
      }

      if (isResultEvent) {
        entries.push({
          kind: 'result',
          id: event.id,
          event,
          isLatestEvaluate: Boolean(latestEvaluate && latestEvaluate.id === event.id),
          isLatestFailed: Boolean(latestFailedEval && latestFailedEval.id === event.id && !state.session.passed)
        });
        return;
      }

      if (isTestsEvent) {
        entries.push({
          kind: 'tests',
          id: event.id,
          event,
          testCode
        });
        return;
      }

      if (isPlanEvent) {
        entries.push({
          kind: 'plan',
          id: event.id,
          event,
          plan,
          editable: Boolean(
            latestPlan
            && latestPlan.id === event.id
            && state.workflowMode === 'continue'
            && state.interactiveState === 'await_plan'
            && isInteractiveSelected()
          )
        });
        return;
      }

      if (event.stage === 'auto' || event.stage === 'session' || event.status === 'failed') {
        entries.push({
          kind: 'note',
          id: event.id,
          event
        });
      }
    });

    state.localLogs.forEach((event) => {
      entries.push({
        kind: 'note',
        id: event.id,
        event
      });
    });

    return entries;
  }

  function renderTimeline() {
    syncEditablePlanDraft();
    const entries = conversationEntries();
    const timelineSignature = entries.map((entry) => entry.id).join('|');
    const hasTimelineChange = timelineSignature !== state.lastTimelineSignature;
    const shouldStickToBottom = state.running
      || state.autoScrollPinned
      || isNearConversationBottom()
      || hasTimelineChange;

    timeline.innerHTML = '';
    state.lastTimelineSignature = timelineSignature;

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No conversation yet. Send a prompt to begin.';
      timeline.appendChild(empty);
      if (shouldStickToBottom) {
        requestConversationAutoScroll();
      }
      return;
    }

    entries.forEach((entry) => {
      if (entry.kind === 'prompt') {
        const promptCard = renderPromptCard();
        if (promptCard) {
          timeline.appendChild(promptCard);
        }
        return;
      }

      if (entry.kind === 'code') {
        timeline.appendChild(renderCodeCard(entry.event, entry.code));
        return;
      }

      if (entry.kind === 'result') {
        timeline.appendChild(renderResultCard(entry.event, entry.isLatestEvaluate, entry.isLatestFailed));
        return;
      }

      if (entry.kind === 'plan') {
        timeline.appendChild(renderPlanCard(entry.event, entry.plan, entry.editable));
        return;
      }

      if (entry.kind === 'tests') {
        timeline.appendChild(renderTestsCard(entry.event, entry.testCode));
        return;
      }

      timeline.appendChild(renderNoteCard(entry.event));
    });

    if (shouldStickToBottom) {
      requestConversationAutoScroll();
    }
  }

  function renderProfileOptions() {
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

    const active = state.activeProfileId || (state.profiles[0] && state.profiles[0].id) || '';
    taskProfileSelect.value = active;
    settingsProfileSelect.value = state.profiles.some((item) => item.id === currentSettings) ? currentSettings : active;
  }

  function loadProfileEditor() {
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
    profileHint.textContent = profile.apiKey
      ? 'API key is currently set for this profile.'
      : 'API key is empty for this profile.';
  }

  function startNewProfile(returnToTask) {
    state.editingProfileId = '';
    state.returnToTaskAfterSave = returnToTask;
    loadProfileEditor();
    switchPage('settings');
  }

  function syncResolvedTestsEditor(force) {
    const activeSessionId = state.session && state.session.session_id ? state.session.session_id : '';
    const sessionChanged = activeSessionId !== state.lastSessionId;
    const incoming = state.session && typeof state.session.resolved_test_code === 'string'
      ? state.session.resolved_test_code
      : '';

    if (force || sessionChanged || !state.resolvedTestsDirty || incoming === editableCodeText(resolvedTestsEditor)) {
      setEditableCodeText(resolvedTestsEditor, incoming);
      state.resolvedTestsDirty = false;
    }

    state.lastSessionId = activeSessionId;
    refreshEditableCodeBlocks();
  }

  function syncLayout() {
    const showGeneratedTests = testModeSelect.value === 'generate'
      || Boolean(state.session && state.session.test_mode === 'generate');
    if (manualTestsSection) {
      manualTestsSection.classList.toggle('hidden', showGeneratedTests);
    }
    testsWorkspaceSection.classList.toggle('hidden', !showGeneratedTests);
  }

  function renderSetupSummaries() {
    if (modelSummary) {
      const profile = findProfile(taskProfileSelect.value || state.activeProfileId);
      const profileName = profile ? profile.name : 'No profile';
      modelSummary.textContent = profileName + (contextEnabledInput.checked ? ' / context on' : ' / context off');
    }
    if (testsSummary) {
      if (testModeSelect.value === 'generate') {
        const count = editableCodeText(resolvedTestsEditor).trim().length;
        testsSummary.textContent = count > 0 ? 'Generated tests selected' : 'Generate tests';
        return;
      }
      const count = editableCodeText(testInput).trim().length;
      testsSummary.textContent = count > 0 ? 'Manual tests selected' : 'Manual tests';
    }
  }

  function renderComposerStatus() {
    let text = '';
    let statusClass = '';

    if (state.running) {
      text = state.interruptRequested
        ? 'Stopping after the current stage...'
        : (state.runningLabel || 'Running...');
      statusClass = 'running';
    } else if (state.canResume) {
      text = state.resumeLabel || 'Workflow paused. Resume to continue.';
      statusClass = 'waiting';
    } else if (!state.session) {
      text = '';
    } else if (state.session.passed) {
      text = 'Run passed. Review the latest result in the conversation or insert the generated code.';
      statusClass = 'passed';
    } else if (state.workflowMode === 'continue' && state.interactiveState === 'await_plan') {
      text = 'Paused on the latest plan. Edit it, regenerate it, or move to the next step when ready.';
      statusClass = 'waiting';
    } else if (state.workflowMode === 'continue' && state.interactiveState === 'await_failure_choice') {
      text = 'The latest result is waiting for your choice: next step, restart, or end here.';
      statusClass = 'waiting';
    } else if (state.session.status === 'failed') {
      text = 'The latest run failed. Review the newest result in the conversation.';
      statusClass = 'failed';
    }

    composerStatus.textContent = text;
    composerStatus.className = text
      ? 'composer-status visible ' + statusClass
      : 'composer-status';
  }

  function renderResolvedTestsHint() {
    if (!state.session) {
      resolvedTestsHint.textContent = testModeSelect.value === 'generate'
        ? 'Generate assert tests directly from the current requirement. No extra test description is used.'
        : 'Switch to generated tests mode to keep a separate editable test suite outside workflow history and model context.';
      syncResolvedTestsEditor(false);
      return;
    }

    resolvedTestsHint.textContent = state.session.test_mode === 'generate'
      ? (state.resolvedTestsDirty
        ? 'Generated tests have local edits. Use them before evaluation if you want the edited version to be selected immediately.'
        : 'Generated tests stay separate from workflow history and model context. The selected test code is used by evaluation.')
      : 'Manual test mode uses the Tests box above directly.';
    syncResolvedTestsEditor(false);
  }

  function syncActionButtons() {
    const hasSession = Boolean(state.session);
    const isGenerateTestMode = testModeSelect.value === 'generate'
      || Boolean(state.session && state.session.test_mode === 'generate');
    const hasProblemDraft = Boolean(problemInput.value.trim());
    const hasResolvedTestsDraft = Boolean(editableCodeText(resolvedTestsEditor).trim());

    submitWorkflowBtn.disabled = state.running;
    resumeWorkflowBtn.disabled = state.running || !state.canResume;
    interruptWorkflowBtn.disabled = !state.running || state.interruptRequested;
    clearSessionBtn.disabled = state.running;
    generateTestsBtn.disabled = state.running || !isGenerateTestMode || (!hasSession && !hasProblemDraft);
    saveResolvedTestsBtn.disabled = state.running || !isGenerateTestMode || !hasSession || !hasResolvedTestsDraft;
  }

  function resetTaskDraft() {
    state.localLogs = [];
    state.resolvedTestsDirty = false;
    state.editablePlanEventId = '';
    state.editablePlanText = '';
    state.editingPlanSource = false;
    state.lastTimelineSignature = '';
    state.session = null;
    state.lastSessionId = '';
    problemInput.value = '';
    setEditableCodeText(testInput, '');
    setEditableCodeText(resolvedTestsEditor, '');
    refreshEditableCodeBlocks();
    renderAll();
    problemInput.focus();
  }

  function renderAll() {
    updateTestInputPlaceholder();
    renderProfileOptions();
    renderResolvedTestsHint();
    renderComposerStatus();
    syncLayout();
    renderSetupSummaries();
    syncActionButtons();
    renderTimeline();
  }

  function currentRequestPayload() {
    return {
      problem: problemInput.value,
      testText: selectedTestText(),
      testMode: testModeSelect.value === 'generate' ? 'generate' : 'manual',
      resolvedTestCode: selectedResolvedTestCode(),
      contextEnabled: Boolean(contextEnabledInput.checked),
      maxRounds: 10,
      executionMode: executionModeSelect.value === 'continue' ? 'continue' : 'auto'
    };
  }

  openSettingsBtn.addEventListener('click', function () {
    if (!state.editingProfileId) {
      state.editingProfileId = state.activeProfileId || (state.profiles[0] && state.profiles[0].id) || '';
      loadProfileEditor();
    }
    switchPage('settings');
  });

  backToWorkflowBtn.addEventListener('click', function () {
    switchPage('task');
  });

  showOutputBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'showOutput' });
  });

  taskProfileSelect.addEventListener('change', function () {
    const profileId = taskProfileSelect.value;
    state.activeProfileId = profileId;
    renderSetupSummaries();
    vscode.postMessage({ type: 'switchProfile', profileId });
  });

  settingsProfileSelect.addEventListener('change', function () {
    state.editingProfileId = settingsProfileSelect.value;
    loadProfileEditor();
  });

  executionModeSelect.addEventListener('change', function () {
    renderAll();
  });

  testModeSelect.addEventListener('change', function () {
    renderAll();
  });

  contextEnabledInput.addEventListener('change', function () {
    renderSetupSummaries();
  });

  function bindEditableCodeInput(element, onInput) {
    if (!element) {
      return;
    }
    element.addEventListener('focus', function () {
      prepareEditableCodeForInput(element);
    });
    element.addEventListener('blur', function () {
      highlightEditableCode(element);
      renderSetupSummaries();
    });
    element.addEventListener('input', onInput);
  }

  bindEditableCodeInput(testInput, function () {
    renderSetupSummaries();
    syncActionButtons();
  });

  bindEditableCodeInput(resolvedTestsEditor, function () {
    state.resolvedTestsDirty = true;
    refreshEditableCodeBlocks();
    renderResolvedTestsHint();
    renderSetupSummaries();
    syncActionButtons();
  });

  problemInput.addEventListener('input', function () {
    syncActionButtons();
  });

  newProfileBtn.addEventListener('click', function () {
    startNewProfile(false);
  });

  openProfileConfigBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'openProfileConfig' });
  });

  reloadProfilesBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'reloadProfiles' });
  });

  saveProfileBtn.addEventListener('click', function () {
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
      state.returnToTaskAfterSave = false;
      switchPage('task');
    }
  });

  deleteProfileBtn.addEventListener('click', function () {
    if (!state.editingProfileId) {
      addLocalLog('Profile', 'No profile selected for deletion.', 'failed');
      return;
    }
    vscode.postMessage({
      type: 'deleteProfile',
      id: state.editingProfileId
    });
  });

  useSelectionForProblemBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'useEditorSelection', target: 'problem' });
  });

  useSelectionForTestsBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'useEditorSelection', target: 'tests' });
  });

  submitWorkflowBtn.addEventListener('click', function () {
    state.localLogs = [];
    state.editablePlanEventId = '';
    state.editablePlanText = '';
    state.editingPlanSource = false;
    vscode.postMessage(Object.assign({ type: 'runWorkflow' }, currentRequestPayload()));
  });

  resumeWorkflowBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'resumeWorkflow' });
  });

  interruptWorkflowBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'interruptWorkflow' });
  });

  clearSessionBtn.addEventListener('click', function () {
    resetTaskDraft();
    vscode.postMessage({ type: 'clearWorkflowSession' });
  });

  generateTestsBtn.addEventListener('click', function () {
    state.resolvedTestsDirty = false;
    vscode.postMessage(Object.assign({
      type: 'runWorkflowAction',
      action: 'generate_tests',
      useErrorFeedback: true
    }, currentActionPayload()));
  });

  saveResolvedTestsBtn.addEventListener('click', function () {
    state.resolvedTestsDirty = false;
    vscode.postMessage({
      type: 'updateResolvedTests',
      resolvedTestCode: editableCodeText(resolvedTestsEditor)
    });
  });

  problemInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !state.running) {
      event.preventDefault();
      submitWorkflowBtn.click();
    }
  });

  if (conversationScroll) {
    conversationScroll.addEventListener('scroll', function () {
      state.autoScrollPinned = isNearConversationBottom();
    });
  }

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (!data || typeof data.type !== 'string') {
      return;
    }

    switch (data.type) {
      case 'switchPage':
        switchPage(data.page === 'settings' ? 'settings' : 'task');
        break;
      case 'state':
        state.profiles = Array.isArray(data.profiles) ? data.profiles : [];
        state.activeProfileId = typeof data.activeProfileId === 'string' ? data.activeProfileId : '';
        state.session = data.session && typeof data.session === 'object' ? data.session : null;
        state.workflowMode = data.workflowMode === 'continue' ? 'continue' : 'auto';
        state.interactiveState = typeof data.interactiveState === 'string' ? data.interactiveState : 'idle';
        state.canResume = Boolean(data.canResume);
        state.resumeLabel = typeof data.resumeLabel === 'string' ? data.resumeLabel : '';
        state.interruptRequested = Boolean(data.interruptRequested);
        executionModeSelect.value = state.workflowMode;
        if (state.session) {
          problemInput.value = state.session.problem_statement || problemInput.value;
          setEditableCodeText(testInput, state.session.test_text || editableCodeText(testInput));
          testModeSelect.value = state.session.test_mode === 'generate' ? 'generate' : 'manual';
          contextEnabledInput.checked = Boolean(state.session.context_enabled);
        }
        if (!state.editingProfileId || !findProfile(state.editingProfileId)) {
          state.editingProfileId = state.activeProfileId || (state.profiles[0] && state.profiles[0].id) || '';
        }
        loadProfileEditor();
        renderAll();
        break;
      case 'workflowSession':
        state.session = data.session && typeof data.session === 'object' ? data.session : null;
        state.workflowMode = data.workflowMode === 'continue' ? 'continue' : 'auto';
        state.interactiveState = typeof data.interactiveState === 'string' ? data.interactiveState : 'idle';
        state.canResume = Boolean(data.canResume);
        state.resumeLabel = typeof data.resumeLabel === 'string' ? data.resumeLabel : '';
        state.interruptRequested = Boolean(data.interruptRequested);
        executionModeSelect.value = state.workflowMode;
        if (state.session) {
          problemInput.value = state.session.problem_statement || problemInput.value;
          setEditableCodeText(testInput, state.session.test_text || editableCodeText(testInput));
          testModeSelect.value = state.session.test_mode === 'generate' ? 'generate' : 'manual';
          contextEnabledInput.checked = Boolean(state.session.context_enabled);
        }
        if (!state.session) {
          state.lastSessionId = '';
          state.lastTimelineSignature = '';
        }
        renderAll();
        break;
      case 'prefillProblem':
        if (typeof data.problem === 'string') {
          problemInput.value = data.problem;
        }
        break;
      case 'prefillTestText':
        if (typeof data.testText === 'string') {
          setEditableCodeText(testInput, data.testText);
          renderAll();
        }
        break;
      case 'runState':
        state.running = Boolean(data.running);
        state.runningLabel = typeof data.label === 'string' ? data.label : '';
        renderComposerStatus();
        syncActionButtons();
        renderTimeline();
        break;
      case 'log':
        if (typeof data.text === 'string') {
          addLocalLog('Log', data.text, typeof data.level === 'string' ? data.level : 'ready');
        }
        break;
      case 'workflowError':
        addLocalLog('Workflow Error', typeof data.reason === 'string' ? data.reason : 'Unknown workflow error.', 'failed');
        renderComposerStatus();
        break;
      default:
        break;
    }
  });

  switchPage('task');
  renderAll();
  vscode.postMessage({ type: 'ready' });
})();
