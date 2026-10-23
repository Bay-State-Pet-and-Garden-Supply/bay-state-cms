import React, { useState, useEffect, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import {
  fetchStoreManagerModels,
  fetchStoreManagerCommands,
  executeStoreManagerCommand,
  resolveStoreManagerScope,
  fetchStoreManagerConsoleState,
  type StoreManagerModelDescriptor,
  type StoreManagerCommandDescriptor,
  type StoreManagerPinnedScope,
  type StoreManagerResolvedScope,
  type StoreManagerConsoleFlags,
  type StoreManagerModelSelection,
} from '../store-manager-api';
import {
  approvalCardCopy,
  deniedOutcomeText,
  approvedAwaitingExecutionText,
} from '../store-manager-logic';
import { isCommandInput, summarizeCommandResult } from '../store-manager-command-logic';
import { CommandPalette } from './store-manager/CommandPalette';
import { ScopePin } from './store-manager/ScopePin';
import { PlanPreview } from './store-manager/PlanPreview';
import { PreferencesPanel } from './store-manager/PreferencesPanel';
import { ManagerInbox } from './store-manager/ManagerInbox';
import { NotificationCenter } from './store-manager/NotificationCenter';
import { SchedulesPanel } from './store-manager/SchedulesPanel';
import { TriggersPanel } from './store-manager/TriggersPanel';
import { PlaybooksPanel } from './store-manager/PlaybooksPanel';
import { BulkReviewPanel } from './store-manager/BulkReviewPanel';
import { RunHistory } from './store-manager/RunHistory';
import { RunInspector } from './store-manager/RunInspector';
import { RunComparison } from './store-manager/RunComparison';
import { OperationsConsole } from './store-manager/OperationsConsole';
import { OperationsNav, type OperationsViewId, type OperationsViewDescriptor } from './store-manager/OperationsNav';
import { useStoreManagerEvents } from '../hooks/useStoreManagerEvents';
import { colors, fonts, rounded, themeStyles } from '../theme';
import { ViewHeader } from './common/ViewHeader';

interface StoreManagerAssistantProps {
  onSelectProduct?: (sku: string) => void;
}

interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
}

interface SelectedProduct {
  sku: string;
  title: string;
  primaryImage?: string | null;
}

/** Server-enforced attachment limit (mirrors MAX_ATTACHED_SKUS in store-manager-context.ts). */
const MAX_ATTACHED_PRODUCTS = 10;

/** Pre-fetch default mirrors the server defaults: the shipped console surface
 * (chat, inbox, commands, scope, preferences, history) is enabled; only the
 * opt-in automation (schedules, triggers, playbooks, bulk review,
 * notifications) is inert until the server says otherwise. */
const ALL_FLAGS_OFF: StoreManagerConsoleFlags = {
  operationsConsoleEnabled: true,
  schedulesEnabled: false,
  eventTriggersEnabled: false,
  playbooksEnabled: false,
  bulkReviewEnabled: false,
  notificationsEnabled: false,
  killSwitch: false,
};

/** Server-owned console views (labels/icons are presentation only — capability is server-gated). */
const CONSOLE_VIEWS: OperationsViewDescriptor[] = [
  { id: 'chat', label: 'Catalog Help', icon: '💬' },
  { id: 'inbox', label: 'Needs attention', icon: '📥' },
  { id: 'schedules', label: 'Scheduled tasks', icon: '⏰' },
  { id: 'triggers', label: 'Automatic rules', icon: '⚡' },
  { id: 'playbooks', label: 'Saved routines', icon: '📋' },
  { id: 'bulk', label: 'Review multiple products', icon: '📦' },
  { id: 'history', label: 'Recent activity', icon: '🕘' },
  { id: 'preferences', label: 'Settings', icon: '⚙' },
];

const generateUuid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2) + Date.now().toString(36);

export function StoreManagerAssistant({ onSelectProduct }: StoreManagerAssistantProps) {
  const [currentThreadId, setCurrentThreadId] = useState<string>(generateUuid());
  const [currentThreadTitle, setCurrentThreadTitle] = useState<string>('');
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [input, setInput] = useState('');
  
  // Model selection state — populated from the server-owned descriptor
  // endpoint; there is no hard-coded client model catalog. The selection is
  // either `{ mode: 'route_default' }` (follow the configured route, keeping
  // its fallback semantics) or a connection-addressed `explicit` override
  // (manual picker change — disables route fallback). The configured default
  // is NEVER converted into an explicit selection.
  const [selectedModel, setSelectedModel] = useState<StoreManagerModelSelection | null>(null);
  const [modelOptions, setModelOptions] = useState<StoreManagerModelDescriptor[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // Operations console (Issue 2): slash commands, pinned scope, preferences.
  const [commands, setCommands] = useState<StoreManagerCommandDescriptor[]>([]);
  const [pinnedScope, setPinnedScope] = useState<StoreManagerResolvedScope | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  // Operations console (Issue 9): server-owned console state + navigation.
  const [consoleFlags, setConsoleFlags] = useState<StoreManagerConsoleFlags>(ALL_FLAGS_OFF);
  const [activeView, setActiveView] = useState<OperationsViewId>('chat');
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null);
  const [compareRunId, setCompareRunId] = useState<string | null>(null);
  const { notifications, status: eventStatus, markRead: markNotificationRead } = useStoreManagerEvents();
  const [commandOutput, setCommandOutput] = useState<{
    raw: string;
    loading: boolean;
    text?: string;
    plan?: import('../store-manager-api').StoreManagerPreviewDescriptor;
    error?: string;
  } | null>(null);

  // Product context attachment states
  const [selectedProducts, setSelectedProducts] = useState<SelectedProduct[]>([]);
  const [attachmentLimitReached, setAttachmentLimitReached] = useState(false);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [modalSearchQuery, setModalSearchQuery] = useState('');
  const [modalProducts, setModalProducts] = useState<SelectedProduct[]>([]);
  const [modalLoading, setModalLoading] = useState(false);

  // ShopSite Media URL for displaying product images
  const [mediaUrl] = useState(() => localStorage.getItem('shopsite_media_url') || '');

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Track selected products and model in refs to avoid stale closures in transport constructor
  const selectedProductsRef = useRef(selectedProducts);
  useEffect(() => {
    selectedProductsRef.current = selectedProducts;
  }, [selectedProducts]);

  const selectedModelRef = useRef(selectedModel);
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  const pinnedScopeRef = useRef(pinnedScope);
  useEffect(() => {
    pinnedScopeRef.current = pinnedScope;
  }, [pinnedScope]);

  // Load the server-owned model descriptor list on mount.
  useEffect(() => {
    let cancelled = false;
    fetchStoreManagerModels()
      .then(data => {
        if (cancelled) return;
        setModelOptions(data.models);
      })
      .catch(() => {
        if (cancelled) return;
        setModelOptions([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the server-owned command palette descriptors (the client never
  // maintains a second command catalog).
  useEffect(() => {
    let cancelled = false;
    fetchStoreManagerCommands()
      .then(cmd => {
        if (!cancelled) setCommands(cmd);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the server-owned operations-console state (Issue 9): effective
  // flags + defaults. Reads stay available under the kill switch; the UI
  // only disables run-producing views. Failing to load keeps the ALL-OFF
  // defaults so the console never shows enabled surfaces by accident.
  useEffect(() => {
    let cancelled = false;
    fetchStoreManagerConsoleState()
      .then((state) => {
        if (!cancelled) setConsoleFlags(state.flags);
      })
      .catch(() => {
        if (!cancelled) setConsoleFlags(ALL_FLAGS_OFF);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the selection valid across refresh/config changes: never keep an
  // unavailable stale value selected. A manual explicit pick must reference a
  // descriptor that still exists; otherwise reset to route_default (the
  // configured default must never become an explicit selection).
  useEffect(() => {
    setSelectedModel(prev => {
      const stillUsable = (sel: StoreManagerModelSelection | null): boolean => {
        if (!sel) return false;
        if (typeof sel === 'string') {
          // Legacy bare model id (only ever sent by older clients/persisted defs).
          return modelOptions.some(m => m.id === sel);
        }
        if (sel.mode === 'route_default') return modelOptions.length > 0;
        return modelOptions.some(
          m => m.id === sel.target.modelId && m.provider === sel.target.connectionId,
        );
      };
      if (prev && stillUsable(prev)) return prev;
      return modelOptions.length > 0 ? { mode: 'route_default' } : null;
    });
  }, [modelOptions]);

  const currentThreadIdRef = useRef(currentThreadId);
  useEffect(() => {
    currentThreadIdRef.current = currentThreadId;
  }, [currentThreadId]);


  // Set up the default transport pointing to our Hono chat route
  const transport = useRef(
    new DefaultChatTransport({
      api: '/api/store-manager/chat',
      body: () => ({
        selectedSkus: selectedProductsRef.current.map(p => p.sku),
        selectedModel: selectedModelRef.current,
        threadId: currentThreadIdRef.current,
        // Pinned conversational scope (Issue 2): bounded identifiers only;
        // the server resolves + workspace-checks it before the run.
        pinnedScope: pinnedScopeRef.current?.pinnedScope ?? null,
      }),
    })
  );

  const { messages, sendMessage, status, error, setMessages, addToolApprovalResponse } = useChat({
    transport: transport.current,
    // #34: when the assistant message has complete tool-approval responses,
    // resubmit automatically so the server validates the HMAC signature and
    // executes the approved tool.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  // Session cost is derived exclusively from server-attached message metadata
  // (epic #42, #37): the durable model-call row id, resolved provider/model,
  // aggregate tokens, and honest cost basis. Client-supplied `usage` is never
  // accepted.
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);


  // #34: per-approval decision state (blocks duplicate clicks while a decision
  // is being submitted).
  const [approvalDecisions, setApprovalDecisions] = useState<Record<string, 'approving' | 'denying'>>({});

  const handleApprovalDecision = async (approvalId: string, approved: boolean) => {
    if (status === 'submitted' || status === 'streaming') return;
    if (approvalDecisions[approvalId]) return;
    setApprovalDecisions(prev => ({ ...prev, [approvalId]: approved ? 'approving' : 'denying' }));
    try {
      await addToolApprovalResponse({
        id: approvalId,
        approved,
        reason: approved ? undefined : 'Denied by operator.',
      });
    } catch (err) {
      console.error('Failed to submit approval response:', err);
    } finally {
      setApprovalDecisions(prev => {
        const next = { ...prev };
        delete next[approvalId];
        return next;
      });
    }
  };

  // Autocomplete search for products in the modal
  useEffect(() => {
    if (!showAttachModal) return;

    const delayDebounce = setTimeout(() => {
      setModalLoading(true);
      fetch(`/api/products?search=${encodeURIComponent(modalSearchQuery)}&limit=24`)
        .then(res => res.json())
        .then(data => {
          setModalProducts(data.products || []);
          setModalLoading(false);
        })
        .catch(err => {
          console.error('Failed to search products for modal:', err);
          setModalLoading(false);
        });
    }, 200);

    return () => clearTimeout(delayDebounce);
  }, [modalSearchQuery, showAttachModal]);

  // Load thread list on mount
  const loadThreads = async (selectActiveId?: string) => {
    try {
      const res = await fetch('/api/store-manager/chat/threads');
      const data = await res.json();
      const loadedThreads = data.threads || [];
      setThreads(loadedThreads);

      if (loadedThreads.length > 0) {
        const targetId = selectActiveId || loadedThreads[0].id;
        const matchingThread = loadedThreads.find((t: ChatThread) => t.id === targetId);
        
        if (matchingThread) {
          setCurrentThreadId(matchingThread.id);
          setCurrentThreadTitle(matchingThread.title);
          loadThreadMessages(matchingThread.id);
        } else {
          setCurrentThreadId(loadedThreads[0].id);
          setCurrentThreadTitle(loadedThreads[0].title);
          loadThreadMessages(loadedThreads[0].id);
        }
      } else {
        startNewChat();
      }
    } catch (err) {
      console.error('Failed to load chat threads:', err);
    }
  };

  useEffect(() => {
    loadThreads();
  }, []);

  // Load messages for a specific thread
  const loadThreadMessages = async (threadId: string) => {
    try {
      const res = await fetch(`/api/store-manager/chat/${threadId}`);
      const data = await res.json();
      setMessages(data.messages || []);
    } catch (err) {
      console.error('Failed to load thread messages:', err);
    }
  };

  // Switch to a different thread
  const selectThread = (thread: ChatThread) => {
    if (status === 'streaming' || status === 'submitted') return;
    setCurrentThreadId(thread.id);
    setCurrentThreadTitle(thread.title);
    loadThreadMessages(thread.id);
    setSelectedProducts([]); // Reset context on thread switch
  };

  // Initialize a fresh new chat thread
  const startNewChat = () => {
    if (status === 'streaming' || status === 'submitted') return;
    const newId = generateUuid();
    setCurrentThreadId(newId);
    setCurrentThreadTitle('');
    setMessages([]);
    setSelectedProducts([]);
    setAttachmentLimitReached(false);
  };

  // Attach/Toggle a product context (dedupe by SKU; enforce the attachment cap)
  const toggleProductContext = (product: SelectedProduct) => {
    if (selectedProducts.some(p => p.sku === product.sku)) {
      setSelectedProducts(selectedProducts.filter(p => p.sku !== product.sku));
    } else if (selectedProducts.length >= MAX_ATTACHED_PRODUCTS) {
      setAttachmentLimitReached(true);
    } else {
      setSelectedProducts([...selectedProducts, product]);
    }
  };

  // Remove an attached product context
  const removeProductContext = (sku: string) => {
    setSelectedProducts(selectedProducts.filter(p => p.sku !== sku));
    setAttachmentLimitReached(false);
  };

  // Resolve image URL
  const getProductImageUrl = (primaryImage?: string | null) => {
    if (!primaryImage) return '';
    return mediaUrl ? (mediaUrl.endsWith('/') ? mediaUrl : mediaUrl + '/') + primaryImage : '';
  };

  // Auto-scroll to bottom of chat on new message or status change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  // Save chat history whenever messages list is updated and assistant is ready
  const lastMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    const saveChat = async () => {
      if (status === 'ready' && messages.length > 0 && messages.length !== lastMessagesLengthRef.current) {
        lastMessagesLengthRef.current = messages.length;

        let title = currentThreadTitle;
        if (!title) {
          const firstUserMsg = messages.find(m => m.role === 'user');
          if (firstUserMsg && firstUserMsg.parts) {
            const textPart = firstUserMsg.parts.find(p => p.type === 'text');
            if (textPart && textPart.type === 'text') {
              const cleaned = textPart.text.replace(/[#*`]/g, '').trim();
              title = cleaned.substring(0, 32) + (cleaned.length > 32 ? '...' : '');
            }
          }
          if (!title) {
            title = `Chat - ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          }
          setCurrentThreadTitle(title);
        }

        try {
          await fetch(`/api/store-manager/chat/${currentThreadId}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, threadTitle: title }),
          });
          await loadThreads(currentThreadId);
        } catch (err) {
          console.error('Failed to save chat history:', err);
        }
      }
    };
    saveChat();
  }, [messages, status, currentThreadId, currentThreadTitle]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || status === 'submitted' || status === 'streaming') return;
    if (!selectedModel) return; // no usable model configured
    // Slash commands (Issue 2): compile + execute through the runtime — never
    // a local execution path. /plan returns a zero-execution preview.
    if (isCommandInput(input)) {
      runCommand(input.trim());
      setInput('');
      return;
    }
    sendMessage({ text: input.trim() });
    setInput('');
  };

  /** Execute a slash command (or its /plan preview) through the server runtime. */
  const runCommand = async (raw: string) => {
    if (status === 'submitted' || status === 'streaming') return;
    const mode = raw.startsWith('/plan') ? 'plan' : 'execute';
    setCommandOutput({ raw, loading: true });
    try {
      const result = await executeStoreManagerCommand(raw, {
        pinnedScope: pinnedScope?.pinnedScope ?? null,
        selectedModel,
        mode,
      });
      if (mode === 'plan' && 'plan' in result) {
        setCommandOutput({ raw, loading: false, plan: result.plan });
      } else if ('text' in result) {
        setCommandOutput({ raw, loading: false, text: summarizeCommandResult(result) });
      } else {
        setCommandOutput({ raw, loading: false, error: 'Command returned an unexpected result.' });
      }
    } catch (err) {
      setCommandOutput({ raw, loading: false, error: err instanceof Error ? err.message : 'Command failed.' });
    }
  };

  /** Pin a scope (server-validated; the server is stateless, the pin is client-held). */
  const handlePinScope = async (scope: StoreManagerPinnedScope) => {
    setScopeBusy(true);
    setScopeError(null);
    try {
      const resolved = await resolveStoreManagerScope(scope);
      setPinnedScope(resolved);
    } catch {
      setScopeError("That focus couldn't be set. Check the details and try again.");
    } finally {
      setScopeBusy(false);
    }
  };

  const handleStarterPrompt = (promptText: string) => {
    if (status === 'submitted' || status === 'streaming') return;
    sendMessage({ text: promptText });
  };

  const deleteThread = async (e: React.MouseEvent, threadId: string) => {
    e.stopPropagation();
    if (status === 'streaming' || status === 'submitted') return;
    if (!confirm('Are you sure you want to delete this conversation?')) return;

    try {
      await fetch(`/api/store-manager/chat/${threadId}`, { method: 'DELETE' });
      if (threadId === currentThreadId) {
        await loadThreads();
      } else {
        await loadThreads(currentThreadId);
      }
    } catch (err) {
      console.error('Failed to delete chat thread:', err);
    }
  };

  // Helper to parse bold markdown inside text
  const parseInlineMarkdown = (text: string, _isUser = false) => {
    const parts = [];
    let key = 0;
    const regex = /(\*\*|`)(.*?)\1/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(<span key={key++}>{text.substring(lastIndex, match.index)}</span>);
      }
      const marker = match[1];
      const content = match[2];
      if (marker === '**') {
        parts.push(<strong key={key++} style={{ fontWeight: 700, color: 'inherit' }}>{content}</strong>);
      } else {
        parts.push(
          <code
            key={key++}
            style={{
              background: colors.feedBagCream,
              padding: '2px 6px',
              borderRadius: rounded.xs,
              fontFamily: fonts.mono,
              fontSize: '13px',
              color: colors.signetBurgundy,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            {content}
          </code>
        );
      }
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(<span key={key++}>{text.substring(lastIndex)}</span>);
    }

    return parts.length > 0 ? parts : text;
  };

  // Helper renderer for Markdown in assistant/user messages
  const renderMarkdownLine = (line: string, idx: number, isUser = false) => {
    const trimmed = line.trim();
    const textColor = colors.ledgerCharcoal;
    const headColor = colors.ledgerCharcoal;

    if (trimmed.startsWith('# ')) {
      return (
        <h1
          key={idx}
          style={{
            fontFamily: fonts.display,
            fontSize: '20px',
            fontWeight: 700,
            color: headColor,
            margin: '18px 0 8px',
            borderBottom: `1px solid ${colors.cardBorder}`,
            paddingBottom: '4px',
          }}
        >
          {parseInlineMarkdown(trimmed.substring(2), isUser)}
        </h1>
      );
    }
    if (trimmed.startsWith('## ')) {
      return (
        <h2 key={idx} style={{ fontFamily: fonts.display, fontSize: '16px', fontWeight: 700, color: headColor, margin: '14px 0 6px' }}>
          {parseInlineMarkdown(trimmed.substring(3), isUser)}
        </h2>
      );
    }
    if (trimmed.startsWith('### ')) {
      return (
        <h3 key={idx} style={{ fontFamily: fonts.display, fontSize: '14px', fontWeight: 700, color: colors.mulchBrown, margin: '12px 0 4px' }}>
          {parseInlineMarkdown(trimmed.substring(4), isUser)}
        </h3>
      );
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      return (
        <li
          key={idx}
          style={{
            margin: '6px 0 6px 24px',
            paddingLeft: '4px',
            listStyleType: 'disc',
            listStylePosition: 'outside',
            fontSize: '14px',
            color: textColor,
            lineHeight: '1.6',
          }}
        >
          {parseInlineMarkdown(trimmed.substring(2), isUser)}
        </li>
      );
    }
    if (/^\d+\.\s/.test(trimmed)) {
      const content = trimmed.replace(/^\d+\.\s/, '');
      return (
        <li
          key={idx}
          style={{
            margin: '6px 0 6px 24px',
            paddingLeft: '4px',
            listStyleType: 'decimal',
            listStylePosition: 'outside',
            fontSize: '14px',
            color: textColor,
            lineHeight: '1.6',
          }}
        >
          {parseInlineMarkdown(content, isUser)}
        </li>
      );
    }
    if (trimmed === '') {
      return <div key={idx} style={{ height: '8px' }} />;
    }
    return (
      <p key={idx} style={{ margin: '8px 0', fontSize: '14px', color: textColor, lineHeight: '1.6' }}>
        {parseInlineMarkdown(line, isUser)}
      </p>
    );
  };

  const renderMessageContent = (text: string, isUser = false) => {
    if (!text) return null;
    return text.split('\n').map((line, idx) => renderMarkdownLine(line, idx, isUser));
  };

  // Render nice visual cards for tool invocation and output
  const renderToolInvocation = (part: any, key: number) => {
    const { toolName, state, output, errorText, input } = part;
    const isLoading = state === 'input-streaming' || state === 'input-available';

    const renderSkuList = (skus: string[], productTitle = 'Related products') => {
      if (!skus || skus.length === 0) return <em>None</em>;
      return (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {skus.map(sku => (
            <div key={sku} style={{ display: 'inline-flex', gap: 4, background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.xs, padding: '2px 6px', alignItems: 'center' }}>
              <button
                onClick={() => onSelectProduct?.(sku)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '11px',
                  fontFamily: fonts.mono,
                  color: colors.uniformGreen,
                  fontWeight: 700,
                  cursor: 'pointer',
                  padding: 0,
                }}
                title="Click to open product detail"
              >
                {sku}
              </button>
              <button
                onClick={() => toggleProductContext({ sku, title: productTitle })}
                style={{
                  background: 'none',
                  border: 'none',
                  color: selectedProducts.some(p => p.sku === sku) ? colors.signetBurgundy : colors.seedlingGreen,
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '0 2px',
                  fontWeight: 'bold',
                }}
                title={selectedProducts.some(p => p.sku === sku) ? 'Remove product from questions' : 'Ask about this product'}
              >
                {selectedProducts.some(p => p.sku === sku) ? '✕' : '+'}
              </button>
            </div>
          ))}
        </div>
      );
    };

    return (
      <div
        key={key}
        style={{
          margin: '12px 0',
          padding: '12px 16px',
          background: colors.feedBagCream,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.md,
          boxShadow: '0 1px 2px rgba(33,20,20,0.03)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>
            Tool Execution: <code style={{ color: colors.uniformGreen, fontFamily: fonts.mono }}>{toolName}</code>
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: rounded.xs,
              background: isLoading ? colors.cornerCalloutGold : state === 'output-error' ? '#fee2e2' : colors.seedlingGreen,
              color: isLoading ? colors.ledgerCharcoal : state === 'output-error' ? colors.signetBurgundy : colors.feedBagCream,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {isLoading ? 'Running...' : state === 'output-error' ? 'Error' : 'Complete'}
          </span>
        </div>

        {input && Object.keys(input).length > 0 && (
          <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 6, fontFamily: fonts.mono }}>
            Arguments: <code>{JSON.stringify(input).slice(0, 2000)}</code>
          </div>
        )}

        {state === 'output-available' && output && (
          <div style={{ fontSize: 13, borderTop: `1px solid ${colors.cardBorder}`, paddingTop: 8, marginTop: 4 }}>
            {toolName === 'getDashboardStats' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 8 }}>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.mulchBrown, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Total Products</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: colors.ledgerCharcoal }}>{output.metrics?.totalProducts}</div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.seedlingGreen, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Up-to-date products</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: colors.seedlingGreen }}>
                      {output.metrics?.syncedProducts}
                    </div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.signetBurgundy, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Different from your store</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: colors.signetBurgundy }}>
                      {output.metrics?.driftedProducts}
                    </div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.signetBurgundy, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Need a closer look</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: colors.signetBurgundy }}>
                      {output.metrics?.productsWithWarnings}
                    </div>
                  </div>
                </div>
                {output.recentSyncJobs && output.recentSyncJobs.length > 0 && (
                  <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 6, fontFamily: fonts.mono }}>
                    <strong>Last store update:</strong> {output.recentSyncJobs[0].status === 'succeeded' ? 'Complete' : output.recentSyncJobs[0].status === 'failed' ? 'Needs attention' : output.recentSyncJobs[0].status === 'running' ? 'In progress' : 'Check details'} ({output.recentSyncJobs[0].productCount} products)
                  </div>
                )}
              </div>
            )}

            {toolName === 'getCatalogHealthReport' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                  <div style={{ color: colors.seedlingGreen, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>No issues found</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: colors.seedlingGreen }}>
                    {output.healthyProducts}/{output.totalProducts}
                  </div>
                </div>
                <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                  <div style={{ color: colors.signetBurgundy, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Need attention</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: colors.signetBurgundy }}>{output.totalErrors}</div>
                </div>
                <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                  <div style={{ color: colors.mulchBrown, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Please review</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: colors.mulchBrown }}>{output.totalWarnings}</div>
                </div>
              </div>
            )}

            {toolName === 'listCatalogHealthIssues' && Array.isArray(output) && (
              <div>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${colors.cardBorder}`, textAlign: 'left', color: colors.mulchBrown }}>
                      <th style={{ padding: '6px 0' }}>Product code</th>
                      <th style={{ padding: '6px 0' }}>Importance</th>
                      <th style={{ padding: '6px 0' }}>What needs attention</th>
                    </tr>
                  </thead>
                  <tbody>
                    {output.map((issue: any, index: number) => (
                      <tr key={index} style={{ borderBottom: `1px solid ${colors.cardBorder}` }}>
                        <td style={{ padding: '6px 0' }}>
                          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <button
                              onClick={() => onSelectProduct?.(issue.sku)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: colors.uniformGreen,
                                fontFamily: fonts.mono,
                                cursor: 'pointer',
                                fontWeight: 700,
                                padding: 0,
                                fontSize: 12,
                              }}
                            >
                              {issue.sku}
                            </button>
                            <button
                              onClick={() => toggleProductContext({ sku: issue.sku, title: issue.title || 'Catalog Issue' })}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: selectedProducts.some(p => p.sku === issue.sku) ? colors.signetBurgundy : colors.seedlingGreen,
                                cursor: 'pointer',
                                fontSize: '11px',
                                fontWeight: 'bold',
                                padding: 0,
                              }}
                              title={selectedProducts.some(p => p.sku === issue.sku) ? 'Remove product from questions' : 'Ask about this product'}
                            >
                              {selectedProducts.some(p => p.sku === issue.sku) ? '✕' : '+'}
                            </button>
                          </div>
                        </td>
                        <td style={{ padding: '6px 0' }}>
                          <span
                            style={{
                              color: issue.severity === 'blocker' ? colors.signetBurgundy : colors.mulchBrown,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              fontSize: 10,
                            }}
                          >
                            {issue.severity === 'blocker' ? 'Must fix' : 'Please review'}
                          </span>
                        </td>
                        <td style={{ padding: '6px 0', color: colors.ledgerCharcoal }}>
                          {issue.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {toolName === 'searchProducts' && Array.isArray(output) && (
              <div>
                <div style={{ fontWeight: 600, color: colors.mulchBrown, fontSize: 11, marginBottom: 6 }}>
                  {output.length} products found:
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {output.map((prod: any) => (
                    <div
                      key={prod.sku}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 12,
                        background: colors.whiteSurface,
                        padding: '8px 12px',
                        borderRadius: rounded.xs,
                        border: `1px solid ${colors.cardBorder}`,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>
                        <button
                          onClick={() => onSelectProduct?.(prod.sku)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: colors.uniformGreen,
                            fontFamily: fonts.mono,
                            fontWeight: 700,
                            cursor: 'pointer',
                            padding: 0,
                            fontSize: 12,
                          }}
                        >
                          {prod.sku}
                        </button>
                        <button
                          onClick={() => toggleProductContext({ sku: prod.sku, title: prod.title })}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: selectedProducts.some(p => p.sku === prod.sku) ? colors.signetBurgundy : colors.seedlingGreen,
                            cursor: 'pointer',
                            padding: '0 4px',
                            fontSize: '11px',
                            fontWeight: 'bold',
                          }}
                          title={selectedProducts.some(p => p.sku === prod.sku) ? 'Remove product from questions' : 'Ask about this product'}
                        >
                          {selectedProducts.some(p => p.sku === prod.sku) ? '✕' : '+'}
                        </button>{' '}
                        - {prod.title}
                      </span>
                      <span style={{ fontSize: 11, color: colors.mulchBrown, fontFamily: fonts.mono }}>{prod.price == null || prod.price === '' ? 'Price not available' : `Price entered: ${prod.price}`}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {toolName === 'getProductFieldAudit' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.mulchBrown, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Products checked</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>{output.totalProductsScanned}</div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.signetBurgundy, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Missing information</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: colors.signetBurgundy }}>{output.missingCount}</div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.uniformGreen, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Different entries</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: colors.uniformGreen }}>{output.uniqueValueCount}</div>
                  </div>
                </div>

                {output.duplicateGroups && output.duplicateGroups.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 700, color: colors.signetBurgundy, fontSize: 12 }}>
                      Repeated values to review ({output.duplicateGroups.length}{output.totalDuplicateGroupCount > output.duplicateGroups.length ? ` of ${output.totalDuplicateGroupCount}` : ''})
                    </div>
                    <div style={{ maxHeight: 120, overflowY: 'auto', marginTop: 4 }}>
                      {output.duplicateGroups.map((g: any, i: number) => (
                        <div
                          key={i}
                          style={{
                            fontSize: 11,
                            padding: '6px 8px',
                            background: colors.whiteSurface,
                            border: `1px solid ${colors.cardBorder}`,
                            borderRadius: rounded.xs,
                            marginBottom: 4,
                          }}
                        >
                          <strong>{g.type.toUpperCase()}:</strong> "{g.normalized}"
                          <ul style={{ paddingLeft: 12, margin: '2px 0 0 0' }}>
                            {g.values.map((v: any, j: number) => (
                              <li key={j}>
                                "{v.value}" ({v.count} products) {renderSkuList(v.skus, `Brand: ${v.value}`)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {toolName === 'proposeProductFieldNormalization' && (
              <div>
                <div style={{ fontWeight: 700, color: colors.uniformGreen, fontSize: 12, marginBottom: 4 }}>
                  {output.proposalCount} suggestions ready for review
                </div>
                <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 8 }}>
                  Affects {output.affectedProductCount} products. Suggested changes:
                </div>
                <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                  {output.proposals.map((prop: any) => (
                    <div
                      key={prop.id}
                      style={{
                        padding: 8,
                        background: colors.whiteSurface,
                        border: `1px solid ${colors.cardBorder}`,
                        borderRadius: rounded.xs,
                        marginBottom: 6,
                        fontSize: 12,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700 }}>
                          <code>{prop.oldValue}</code> ➔ <code>{prop.newValue}</code>
                        </span>
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: '1px 5px',
                            borderRadius: rounded.xs,
                            background: prop.safeAutoApply ? colors.feedBagCream : '#fee2e2',
                            color: prop.safeAutoApply ? colors.seedlingGreen : colors.signetBurgundy,
                            border: `1px solid ${prop.safeAutoApply ? colors.seedlingGreen : colors.signetBurgundy}`,
                          }}
                        >
                          {prop.safeAutoApply ? 'Can be applied automatically' : 'Needs your approval'}
                        </span>
                      </div>
                      <div style={{ color: colors.mulchBrown, fontSize: 11, marginTop: 4 }}>
                        Why this was suggested: {prop.reason}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        Products affected: {renderSkuList(prop.affectedSkus, `Value: ${prop.newValue}`)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {toolName === 'explainNextActions' && output.actions && (
              <div>
                <div style={{ fontWeight: 700, color: colors.ledgerCharcoal, fontSize: 12, marginBottom: 4 }}>
                  What you can do next:
                </div>
                <ul style={{ paddingLeft: 16, margin: 0, fontSize: 13, color: '#334155' }}>
                  {output.actions.map((act: string, idx: number) => (
                    <li key={idx} style={{ margin: '4px 0' }}>
                      {act}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {toolName === 'generateNormalizationProposals' && (
              <div style={{ color: '#15803d', fontWeight: 600 }}>
                ✅ {output.proposalCount} {output.proposalCount === 1 ? 'suggestion is' : 'suggestions are'} ready to review.
              </div>
            )}

            {toolName === 'applyNormalizationProposal' && (
              <div style={{ color: '#15803d', fontWeight: 600 }}>
                Suggested product changes are ready to review.
              </div>
            )}

            {toolName === 'dismissNormalizationProposal' && (
              <div style={{ color: '#64748b', fontWeight: 600 }}>
                Suggestion dismissed.
              </div>
            )}

            {!['getDashboardStats', 'getCatalogHealthReport', 'listCatalogHealthIssues', 'searchProducts', 'getProductFieldAudit', 'proposeProductFieldNormalization', 'generateNormalizationProposals', 'applyNormalizationProposal', 'dismissNormalizationProposal', 'explainNextActions'].includes(toolName) && (
              <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 8 }}>
                I couldn't show these details clearly. Try asking another question, or contact support for help.
              </div>
            )}
          </div>
        )}

        {state === 'output-error' && errorText && (
          <div style={{ borderTop: '1px solid #fee2e2', paddingTop: 8, marginTop: 8, color: '#ef4444', fontSize: 12 }}>
            I couldn't complete that request. Please try again, or contact support if the problem continues.
          </div>
        )}
      </div>
    );
  };

  // -- Tool approval UI (epic #42, #34) ---------------------------------------

  /** Extract the stable tool name from an AI SDK v7 tool part. */
  const toolNameFromPart = (part: any): string => {
    if (part.type === 'dynamic-tool') return part.toolName || 'unknown-tool';
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) return part.type.slice('tool-'.length);
    return part.toolName || 'unknown-tool';
  };

  /** Adapt a v7 tool part into the shape the existing renderer expects. */
  const adaptToolPart = (part: any) => ({
    toolName: toolNameFromPart(part),
    state: part.state,
    output: part.output,
    errorText: part.errorText,
    input: part.input,
    toolCallId: part.toolCallId,
  });

  /** Blocking approval card. The operator sees the exact action, risk, scope,
   *  and state transition before Approve/Deny. No optimistic success claims. */
  const renderApprovalRequest = (part: any, key: number) => {
    const toolName = toolNameFromPart(part);
    const approvalId: string = part.approval?.id;
    const hasServerSignature = Boolean(part.approval?.signature);
    // #40 change 11: unknown/stale tool parts (legacy history, unknown tool
    // version, unsigned parts) render a read-only safe fallback — never an
    // executable Approve/Deny control.
    if (!hasServerSignature || !approvalId) {
      return (
        <div
          key={key}
          style={{
            margin: '12px 0',
            padding: '12px 16px',
            background: '#f5f5f4',
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            fontSize: 12,
            color: colors.mulchBrown,
          }}
        >
          <strong>Stale or unrecognized approval request</strong> — re-run the action to receive a
          fresh, signed approval. Tool: <code style={{ fontFamily: fonts.mono }}>{toolName}</code>
        </div>
      );
    }
    const copy = approvalCardCopy(toolName, part.input || {});
    const decisionBusy = approvalDecisions[approvalId];
    const isBusy = Boolean(decisionBusy) || status === 'submitted' || status === 'streaming';
    return (
      <div
        key={key}
        style={{
          margin: '12px 0',
          padding: '14px 16px',
          background: '#fef9e7',
          border: `1px solid ${colors.mutedGold}`,
          borderRadius: rounded.md,
          boxShadow: '0 1px 3px rgba(33,20,20,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 16 }}>🔒</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>
            Action requires approval
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: rounded.xs,
              background: colors.mutedGold,
              color: colors.ledgerCharcoal,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {copy.risk}
          </span>
        </div>
        <div style={{ fontSize: 13, color: colors.ledgerCharcoal }}>
          <strong>{copy.title}</strong>
        </div>
        <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 6 }}>
          <div><strong>Scope:</strong> <code style={{ fontFamily: fonts.mono }}>{copy.scope}</code></div>
          <div style={{ marginTop: 2 }}><strong>State transition:</strong> {copy.transition}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button
            className="btn"
            disabled={isBusy}
            onClick={() => handleApprovalDecision(approvalId, true)}
            style={{
              background: colors.seedlingGreen,
              color: colors.feedBagCream,
              border: 'none',
              padding: '6px 18px',
              borderRadius: rounded.sm,
              fontSize: 12,
              fontWeight: 700,
              cursor: isBusy ? 'not-allowed' : 'pointer',
              opacity: isBusy ? 0.6 : 1,
            }}
          >
            {decisionBusy === 'approving' ? 'Approving…' : 'Approve'}
          </button>
          <button
            className="btn"
            disabled={isBusy}
            onClick={() => handleApprovalDecision(approvalId, false)}
            style={{
              background: colors.whiteSurface,
              color: colors.signetBurgundy,
              border: `1px solid ${colors.signetBurgundy}`,
              padding: '6px 18px',
              borderRadius: rounded.sm,
              fontSize: 12,
              fontWeight: 700,
              cursor: isBusy ? 'not-allowed' : 'pointer',
              opacity: isBusy ? 0.6 : 1,
            }}
          >
            Deny
          </button>
        </div>
      </div>
    );
  };

  /** Approval result banner: approved (awaiting execution) or denied (not executed). */
  const renderApprovalResponded = (part: any, key: number) => {
    const toolName = toolNameFromPart(part);
    const approved = part.approval?.approved === true;
    return (
      <div
        key={key}
        style={{
          margin: '12px 0',
          padding: '12px 16px',
          background: approved ? '#ecfdf5' : '#fef2f2',
          border: `1px solid ${approved ? colors.seedlingGreen : colors.signetBurgundy}`,
          borderRadius: rounded.md,
          fontSize: 13,
          fontWeight: 600,
          color: approved ? colors.shadowPine : colors.signetBurgundy,
        }}
      >
        {approved ? approvedAwaitingExecutionText(toolName) : deniedOutcomeText(toolName)}
      </div>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 54px)',
        maxHeight: 'calc(100vh - 54px)',
        background: colors.feedBagCream,
        color: colors.ledgerCharcoal,
        fontFamily: fonts.body,
      }}
    >
      {/* Store Manager Unified Top Header Bar */}
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: colors.whiteSurface,
          borderBottom: `1px solid ${colors.cardBorder}`,
          boxShadow: '0 1px 3px rgba(33,20,20,0.03)',
        }}
      >
        {/* Top Control Row */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 24px',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ViewHeader
              title={CONSOLE_VIEWS.find((view) => view.id === activeView)?.label ?? 'Settings'}
              description={
                activeView === 'chat'
                  ? currentThreadTitle
                    ? `Conversation: "${currentThreadTitle}"`
                    : 'Ask a question about your products or catalog.'
                  : 'Manage store tasks and settings.'
              }
              style={{ marginBottom: 0 }}
              badge={
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: rounded.full,
                    background: !modelsLoading && !selectedModel
                      ? colors.signetBurgundy
                      : status === 'streaming'
                        ? colors.uniformGreen
                        : status === 'submitted'
                          ? colors.signetBurgundy
                          : colors.seedlingGreen,
                    color: colors.feedBagCream,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {modelsLoading
                    ? 'Preparing...'
                    : !selectedModel
                      ? 'Unavailable'
                      : status === 'streaming'
                        ? 'Preparing reply...'
                        : status === 'submitted'
                          ? 'Sending...'
                          : 'Ready'}
                </span>
              }
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <ScopePin
              scope={pinnedScope}
              onPin={handlePinScope}
              onClear={() => setPinnedScope(null)}
              error={scopeError}
              busy={scopeBusy}
            />
            <div
              role="status"
              aria-live="polite"
              style={{ fontSize: '12px', color: colors.mulchBrown, fontWeight: 600 }}
            >
              {modelsLoading
                ? 'Preparing help...'
                : selectedModel
                  ? 'Help is ready'
                  : "Catalog Help isn't available yet. Please ask the person who set up the app."}
            </div>


            <NotificationCenter
              notifications={notifications}
              status={eventStatus}
              onMarkRead={markNotificationRead}
            />
          </div>
        </div>

        {/* Console Nav Tabs Row */}
        <div style={{ padding: '0 24px 10px 24px', borderTop: `1px solid ${colors.cardBorder}`, paddingTop: 10 }}>
          <OperationsConsole
            flags={consoleFlags}
            activeView={activeView}
            onNavigate={setActiveView}
            views={CONSOLE_VIEWS}
            renderView={() => null}
          />
        </div>
      </header>

      {/* Main Workspace Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', position: 'relative', overflow: 'hidden' }}>
        {/* Left Sidebar - Chat History (Contextual to Chat View) */}
        {activeView === 'chat' && (
          <aside
            aria-label="Conversations"
            style={{
              width: isSidebarOpen ? '260px' : '0px',
              minWidth: isSidebarOpen ? '260px' : '0px',
              flexShrink: 0,
              background: colors.feedBagCream,
              borderRight: isSidebarOpen ? `1px solid ${colors.cardBorder}` : 'none',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 8px 16px' }}>
              <button
                onClick={startNewChat}
                className="btn btn-primary"
                style={{
                  flex: 1,
                  padding: '9px 12px',
                  fontFamily: fonts.display,
                  fontSize: '0.8rem',
                  textAlign: 'center',
                }}
              >
                + New conversation
              </button>
              <button
                onClick={() => setIsSidebarOpen(false)}
                title="Hide conversations"
                aria-label="Hide conversations"
                style={{
                  background: colors.whiteSurface,
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.sm,
                  padding: '7px 9px',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: colors.ledgerCharcoal,
                }}
              >
                ◀
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.05em' }}>
                Conversations
              </div>
              
              {threads.length === 0 ? (
                <div style={{ fontSize: '12px', color: colors.mulchBrown, fontStyle: 'italic', textAlign: 'center', marginTop: 16 }}>
                  No recent conversations
                </div>
              ) : (
                threads.map(thread => {
                  const isActive = thread.id === currentThreadId;
                  return (
                    <div
                      key={thread.id}
                      onClick={() => selectThread(thread)}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        width: '100%',
                        padding: '10px 12px',
                        marginBottom: '6px',
                        borderRadius: rounded.md,
                        background: isActive ? colors.whiteSurface : 'transparent',
                        border: isActive ? `1px solid ${colors.uniformGreen}` : '1px solid transparent',
                        boxShadow: isActive ? '0 1px 3px rgba(33,20,20,0.06)' : 'none',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: isActive ? 700 : 500,
                        color: isActive ? colors.ledgerCharcoal : colors.mulchBrown,
                        transition: 'all 0.15s',
                      }}
                      onMouseOver={e => {
                        if (!isActive) e.currentTarget.style.background = colors.whiteSurface;
                      }}
                      onMouseOut={e => {
                        if (!isActive) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px', flex: 1 }}>
                        {thread.title}
                      </span>
                      <button
                        onClick={e => deleteThread(e, thread.id)}
                        style={{
                          border: 'none',
                          background: 'none',
                          padding: 0,
                          color: colors.mulchBrown,
                          cursor: 'pointer',
                          fontSize: '14px',
                        }}
                        onMouseOver={e => (e.currentTarget.style.color = colors.signetBurgundy)}
                        onMouseOut={e => (e.currentTarget.style.color = colors.mulchBrown)}
                        title="Delete conversation"
                        aria-label={`Delete thread ${thread.title}`}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        )}

        {/* Primary Content View Area */}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
          <RunInspector
            runId={inspectedRunId}
            onClose={() => setInspectedRunId(null)}
            onReplay={(runId) => {
              void (async () => {
                try {
                  const api = await import('../store-manager-api');
                  await api.replayStoreManagerRun(runId);
                  setActiveView('history');
                } catch (err) {
                  console.error('Replay failed:', err instanceof Error ? err.message : err);
                }
              })();
            }}
            onCompare={(runId) => {
              setCompareRunId(runId);
            }}
          />
          <RunComparison
            open={compareRunId !== null}
            onClose={() => setCompareRunId(null)}
            preselectedRunId={compareRunId ?? undefined}
          />

          {activeView === 'schedules' ? (
            <SchedulesPanel open onClose={() => setActiveView('chat')} variant="inline" />
          ) : activeView === 'triggers' ? (
            <TriggersPanel open onClose={() => setActiveView('chat')} variant="inline" />
          ) : activeView === 'playbooks' ? (
            <PlaybooksPanel open onClose={() => setActiveView('chat')} variant="inline" />
          ) : activeView === 'bulk' ? (
            <BulkReviewPanel
              open
              onClose={() => setActiveView('chat')}
              onRequestReview={(objective) => {
                if (selectedModel) sendMessage({ text: objective });
                setActiveView('chat');
              }}
              variant="inline"
            />
          ) : activeView === 'inbox' ? (
            <ManagerInbox
              open
              onClose={() => setActiveView('chat')}
              notifications={notifications}
              eventStatus={eventStatus}
              variant="inline"
              onAskManager={(prompt) => {
                if (selectedModel) sendMessage({ text: prompt });
                setActiveView('chat');
              }}
            />
          ) : activeView === 'preferences' ? (
            <PreferencesPanel open onClose={() => setActiveView('chat')} variant="inline" />
          ) : activeView === 'history' ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', background: colors.feedBagCream }}>
              <RunHistory
                open
                onClose={() => setActiveView('chat')}
                onSelectRun={(runId) => {
                  setInspectedRunId(runId);
                }}
              />
            </div>
          ) : activeView === 'chat' ? (
            <>
              {!isSidebarOpen && (
                <div style={{ padding: '16px 32px 0 32px', display: 'flex', alignItems: 'center' }}>
                  <button
                    onClick={() => setIsSidebarOpen(true)}
                    title="Expand sidebar"
                    aria-label="Expand threads sidebar"
                    style={{
                      background: colors.whiteSurface,
                      border: `1px solid ${colors.cardBorder}`,
                      borderRadius: rounded.sm,
                      padding: '6px 12px',
                      cursor: 'pointer',
                      fontSize: 12,
                      color: colors.ledgerCharcoal,
                      fontWeight: 600,
                      boxShadow: '0 1px 2px rgba(33,20,20,0.04)',
                    }}
                  >
                    ▶ Conversations
                  </button>
                </div>
              )}
              {/* Main Chat Body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {messages.length === 0 ? (
            <div style={{ margin: 'auto', maxWidth: 640, textAlign: 'center', padding: '40px 24px', backgroundColor: colors.whiteSurface, borderRadius: rounded.lg, border: `1px solid ${colors.cardBorder}`, boxShadow: '0 1px 3px rgba(33,20,20,0.04)' }}>
              <h3 style={{ fontSize: '20px', fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal, margin: '0 0 8px' }}>
                How can I help manage your store catalog?
              </h3>
              <p style={{ color: colors.mulchBrown, fontSize: '14px', margin: '0 0 24px', lineHeight: 1.6 }}>
                Add products to focus on, or choose one of these common questions.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {[
                  { title: 'What needs attention?', prompt: 'Which of my products need attention?' },
                  { title: 'Find products missing information', prompt: 'Which products are missing important information?' },
                  { title: 'Check product names and brands', prompt: 'Are any product names or brand names inconsistent?' },
                  { title: 'Find products missing pictures', prompt: 'Which products are missing pictures?' },
                  { title: 'Summarize my product categories', prompt: 'Summarize my products by category.' },
                  { title: 'Review suggested changes', prompt: 'Which product changes are waiting for my review?' },
                ].map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleStarterPrompt(item.prompt)}
                    style={{
                      background: colors.whiteSurface,
                      border: `1px solid ${colors.cardBorder}`,
                      borderRadius: rounded.md,
                      padding: '12px 16px',
                      color: colors.ledgerCharcoal,
                      fontSize: '13px',
                      fontWeight: 600,
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                    onMouseOver={e => {
                      e.currentTarget.style.borderColor = colors.uniformGreen;
                      e.currentTarget.style.background = colors.feedBagCream;
                    }}
                    onMouseOut={e => {
                      e.currentTarget.style.borderColor = colors.cardBorder;
                      e.currentTarget.style.background = colors.whiteSurface;
                    }}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message: UIMessage) => {
              const isUser = message.role === 'user';
              return (
                <div
                  key={message.id}
                  style={{
                    display: 'flex',
                    justifyContent: isUser ? 'flex-end' : 'flex-start',
                    margin: '8px 0',
                    animation: 'fadeIn 0.2s ease-out',
                  }}
                >
                  <div
                    style={{
                      maxWidth: isUser ? '75%' : '85%',
                      padding: '16px 20px',
                      borderRadius: rounded.lg,
                      background: isUser ? colors.whiteSurface : colors.whiteSurface,
                      border: `1px solid ${isUser ? colors.seedlingGreen : colors.cardBorder}`,
                      color: colors.ledgerCharcoal,
                      boxShadow: '0 1px 3px rgba(33,20,20,0.04)',
                    }}
                  >
                    <div style={{ fontSize: '11px', color: colors.uniformGreen, fontWeight: 700, marginBottom: 8, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                      {isUser ? 'YOU' : 'STORE MANAGER'}
                    </div>

                    <div className="message-text">
                      {message.parts && message.parts.length > 0 ? (
                        message.parts.map((part, partIdx) => {
                          if (part.type === 'text') {
                            return <div key={partIdx}>{renderMessageContent(part.text, isUser)}</div>;
                          }
                          if (part.type === 'reasoning') {
                            return (
                              <details
                                key={partIdx}
                                style={{
                                  marginTop: 6,
                                  marginBottom: 6,
                                  background: colors.feedBagCream,
                                  padding: 10,
                                  borderRadius: rounded.md,
                                  border: `1px solid ${colors.cardBorder}`,
                                }}
                              >
                                <summary style={{ fontSize: 11, color: colors.mulchBrown, cursor: 'pointer', outline: 'none', fontWeight: 600 }}>
                                  Thinking Process
                                </summary>
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: colors.mulchBrown,
                                    fontStyle: 'italic',
                                    marginTop: 4,
                                    whiteSpace: 'pre-wrap',
                                  }}
                                >
                                  {part.text}
                                </div>
                              </details>
                            );
                          }
                          if (part.type === 'tool-invocation') {
                            return renderToolInvocation(part, partIdx);
                          }
                          if (part.type === 'dynamic-tool' || (typeof part.type === 'string' && part.type.startsWith('tool-') && part.type !== 'tool-invocation')) {
                            // AI SDK v7 tool parts: approval request/response and execution states.
                            const toolPart = part as any;
                            if (toolPart.state === 'approval-requested') {
                              return renderApprovalRequest(toolPart, partIdx);
                            }
                            if (toolPart.state === 'approval-responded') {
                              return renderApprovalResponded(toolPart, partIdx);
                            }
                            return renderToolInvocation(adaptToolPart(toolPart), partIdx);
                          }
                          return null;
                        })
                      ) : (message as any).content ? (
                        <div>{renderMessageContent(String((message as any).content), isUser)}</div>
                      ) : (message as any).text ? (
                        <div>{renderMessageContent(String((message as any).text), isUser)}</div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {status === 'streaming' && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: rounded.md,
                  background: colors.whiteSurface,
                  border: `1px solid ${colors.cardBorder}`,
                  color: colors.mulchBrown,
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  boxShadow: '0 1px 3px rgba(33,20,20,0.05)',
                }}
              >
                <div className="spinner-ring" style={{ width: 14, height: 14, borderWidth: 2, borderTopColor: colors.uniformGreen }} />
                Preparing a reply...
              </div>
            </div>
          )}

          {error && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div
                style={{
                  background: '#fee2e2',
                  border: `1px solid ${colors.signetBurgundy}`,
                  borderRadius: rounded.md,
                  padding: '12px 16px',
                  color: colors.signetBurgundy,
                  fontSize: '13px',
                  fontWeight: 600,
                  maxWidth: 600,
                }}
              >
                Error: {error.message || 'An error occurred during response streaming.'}
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Product Search Grid Modal */}
        {showAttachModal && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(33, 20, 20, 0.4)',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 1000,
            }}
          >
            <div
              style={{
                width: '800px',
                maxWidth: '95%',
                height: '600px',
                maxHeight: '90%',
                backgroundColor: colors.whiteSurface,
                borderRadius: rounded.lg,
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.15)',
                overflow: 'hidden',
                animation: 'fadeIn 0.2s ease-out',
                border: `1px solid ${colors.cardBorder}`,
              }}
            >
              {/* Modal Header */}
              <div
                style={{
                  padding: '18px 24px',
                  borderBottom: `1px solid ${colors.cardBorder}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  backgroundColor: colors.whiteSurface,
                }}
              >
                <div>
                  <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal }}>
                    Attach Product Context
                  </h3>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: colors.mulchBrown }}>
                    Search and select products to inject as conversational context for the Store Manager.
                  </p>
                </div>
                <button
                  onClick={() => setShowAttachModal(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '20px',
                    color: colors.mulchBrown,
                    cursor: 'pointer',
                    padding: '4px',
                  }}
                  onMouseOver={e => e.currentTarget.style.color = colors.signetBurgundy}
                  onMouseOut={e => e.currentTarget.style.color = colors.mulchBrown}
                >
                  ✕
                </button>
              </div>

              {/* Modal Search Bar */}
              <div
                style={{
                  padding: '16px 24px',
                  borderBottom: `1px solid ${colors.cardBorder}`,
                  backgroundColor: colors.feedBagCream,
                }}
              >
                <input
                  type="text"
                  value={modalSearchQuery}
                  onChange={e => setModalSearchQuery(e.target.value)}
                  placeholder="Search by product code or name..."
                  style={{
                    width: '100%',
                    background: colors.whiteSurface,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.md,
                    padding: '10px 16px',
                    fontSize: '14px',
                    outline: 'none',
                    boxSizing: 'border-box',
                    color: colors.ledgerCharcoal,
                  }}
                  autoFocus
                />
              </div>

              {/* Modal Content - Product Grid */}
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '24px',
                  background: colors.feedBagCream,
                }}
              >
                {modalLoading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <div className="spinner-ring" style={{ width: 32, height: 32, borderTopColor: colors.uniformGreen, marginBottom: 12 }} />
                    <span style={{ fontSize: '13px', color: colors.mulchBrown }}>Looking for products...</span>
                  </div>
                ) : modalProducts.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: colors.mulchBrown }}>
                    <span style={{ fontSize: '14px', fontStyle: 'italic' }}>No matching products found</span>
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                      gap: '16px',
                    }}
                  >
                    {modalProducts.map(prod => {
                      const isSelected = selectedProducts.some(p => p.sku === prod.sku);
                      const imageUrl = getProductImageUrl(prod.primaryImage);

                      return (
                        <div
                          key={prod.sku}
                          style={{
                            border: `1px solid ${isSelected ? colors.uniformGreen : colors.cardBorder}`,
                            borderRadius: rounded.md,
                            padding: '12px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            textAlign: 'center',
                            background: colors.whiteSurface,
                            height: '180px',
                            boxShadow: isSelected ? '0 4px 6px -1px rgba(20,83,45,0.1)' : '0 1px 2px rgba(33,20,20,0.03)',
                            transition: 'all 0.15s',
                          }}
                        >
                          {/* Product Image */}
                          <div
                            style={{
                              width: '60px',
                              height: '60px',
                              borderRadius: rounded.sm,
                              background: colors.feedBagCream,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              marginBottom: '8px',
                              overflow: 'hidden',
                              border: `1px solid ${colors.cardBorder}`,
                            }}
                          >
                            {imageUrl ? (
                              <img
                                src={imageUrl}
                                alt={prod.title}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <span style={{ fontSize: '11px', color: colors.mulchBrown, fontWeight: 600 }}>No picture</span>
                            )}
                          </div>

                          {/* Product Text */}
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                            <div
                              style={{
                                fontSize: '12px',
                                fontWeight: 700,
                                color: colors.ledgerCharcoal,
                                marginBottom: '2px',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                                minHeight: '32px',
                              }}
                            >
                              {prod.title}
                            </div>
                            <div style={{ fontSize: '10px', color: colors.mulchBrown, fontFamily: fonts.mono }}>
                              Product code: {prod.sku}
                            </div>
                          </div>

                          {/* Add Context Button */}
                          <button
                            onClick={() => toggleProductContext(prod)}
                            style={{
                              width: '100%',
                              padding: '6px 0',
                              borderRadius: rounded.sm,
                              fontSize: '11px',
                              fontWeight: 600,
                              cursor: 'pointer',
                              border: '1px solid',
                              background: isSelected ? colors.feedBagCream : colors.whiteSurface,
                              color: isSelected ? colors.uniformGreen : colors.ledgerCharcoal,
                              borderColor: isSelected ? colors.uniformGreen : colors.cardBorder,
                              transition: 'all 0.15s',
                            }}
                          >
                            {isSelected ? '✓ Added to question' : '+ Add to question'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div
                style={{
                  padding: '14px 24px',
                  borderTop: `1px solid ${colors.cardBorder}`,
                  display: 'flex',
                  justifyContent: 'flex-end',
                  backgroundColor: colors.whiteSurface,
                }}
              >
                <button
                  onClick={() => setShowAttachModal(false)}
                  className="btn btn-primary"
                  style={{ padding: '8px 20px', fontSize: '0.8rem' }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Attached products preview */}
        {selectedProducts.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              padding: '8px 24px',
              background: colors.feedBagCream,
              borderTop: `1px solid ${colors.cardBorder}`,
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: '10px', fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Products for this question ({selectedProducts.length}/{MAX_ATTACHED_PRODUCTS}):
            </span>
            {attachmentLimitReached && (
              <span style={{ fontSize: '10px', fontWeight: 700, color: colors.signetBurgundy }}>
                You can ask about up to {MAX_ATTACHED_PRODUCTS} products at once. Remove one to add another.
              </span>
            )}
            {selectedProducts.map(p => (
              <span
                key={p.sku}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: colors.whiteSurface,
                  border: `1px solid ${colors.uniformGreen}`,
                  borderRadius: rounded.sm,
                  padding: '3px 8px',
                  fontSize: '12px',
                  color: colors.uniformGreen,
                  fontWeight: 600,
                  boxShadow: '0 1px 2px rgba(33,20,20,0.02)',
                }}
              >
                <strong>Product code {p.sku}</strong> — {p.title.substring(0, 20)}{p.title.length > 20 ? '...' : ''}
                <button
                  type="button"
                  onClick={() => removeProductContext(p.sku)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: colors.mulchBrown,
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    padding: 0,
                    fontSize: '12px',
                    marginLeft: 2,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  onMouseOver={e => (e.currentTarget.style.color = colors.signetBurgundy)}
                  onMouseOut={e => (e.currentTarget.style.color = colors.mulchBrown)}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Command output (Issue 2): structured slash-command result or /plan preview */}
        {commandOutput && (
          <div
            style={{
              padding: '16px 24px',
              background: colors.whiteSurface,
              borderTop: `1px solid ${colors.cardBorder}`,
              maxHeight: 240,
              overflowY: 'auto',
              fontSize: 13,
              color: colors.ledgerCharcoal,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase' }}>
                {commandOutput.loading ? 'Running…' : commandOutput.plan ? 'Plan preview' : 'Command result'}
              </span>
              <button
                type="button"
                onClick={() => setCommandOutput(null)}
                aria-label="Dismiss command output"
                className="btn btn-outline"
                style={{ fontSize: 11, padding: '2px 10px' }}
              >
                ✕
              </button>
            </div>
            {commandOutput.plan ? (
              <PlanPreview
                objective={commandOutput.raw}
                plan={commandOutput.plan}
                loading={commandOutput.loading}
                error={commandOutput.error}
              />
            ) : commandOutput.loading ? (
              <div style={{ color: colors.mulchBrown }}>Command is running through the Store Manager runtime…</div>
            ) : commandOutput.error ? (
              <div style={{ color: colors.signetBurgundy }}>{commandOutput.error}</div>
            ) : (
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  fontFamily: fonts.body,
                  fontSize: 13,
                  margin: 0,
                  color: colors.ledgerCharcoal,
                }}
              >
                {commandOutput.text}
              </pre>
            )}
          </div>
        )}

        {/* Input Form */}
        <form
          onSubmit={handleSend}
          style={{
            padding: '16px 24px',
            background: colors.whiteSurface,
            borderTop: `1px solid ${colors.cardBorder}`,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            position: 'relative',
          }}
        >
          <CommandPalette
            input={input}
            commands={commands}
            onExecute={runCommand}
            onPrefill={(text) => setInput(text)}
          />
          <button
            type="button"
            onClick={() => setShowAttachModal(true)}
            className="btn btn-outline"
            style={{
              height: '2.5rem',
              fontSize: '0.75rem',
              padding: '0 16px',
            }}
            title="Attach product context"
          >
            + Add a product
          </button>

          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={
              !selectedModel
                ? "Catalog Help isn't ready. Please ask the person who set up the app."
                : selectedProducts.length > 0
                  ? 'Ask a question about this product...'
                  : 'Ask a question about your products or catalog...'
            }
            disabled={status === 'submitted' || status === 'streaming' || !selectedModel}
            style={{
              flex: 1,
              background: colors.feedBagCream,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.md,
              padding: '12px 16px',
              color: colors.ledgerCharcoal,
              fontSize: '14px',
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = colors.uniformGreen)}
            onBlur={e => (e.currentTarget.style.borderColor = colors.cardBorder)}
          />
          <button
            type="submit"
            disabled={!input.trim() || status === 'submitted' || status === 'streaming' || !selectedModel}
            className="btn btn-primary"
            style={{
              height: '2.5rem',
              fontSize: '0.8rem',
              padding: '0 24px',
              opacity: !input.trim() || status === 'submitted' || status === 'streaming' || !selectedModel ? 0.6 : 1,
              cursor: !input.trim() || status === 'submitted' || status === 'streaming' || !selectedModel ? 'not-allowed' : 'pointer',
            }}
          >
            Send
          </button>
        </form>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
