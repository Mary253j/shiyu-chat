import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState as NativeAppState, Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { AppState, createId, emptyState, Message, Settings } from '../core/types';
import { buildContextPlan, getBalance, streamChat } from '../core/deepseek';
import { ATTACHMENT_LIMITS, classifyAttachment, type MessageAttachment, type FilePurpose } from '../core/attachments';
import { uploadDeepSeekFile, retrieveDeepSeekFile } from '../core/deepseek-files';
import { createStreamBuffer } from '../core/streamBuffer';
import { exportHistory, mergeConversations, parseHistory, ImportPreview } from '../core/history';
import { checkHistoryInputSize, HISTORY_FILE_LIMIT_LABEL } from '../core/history-limits';
import { deleteAllLocalData, loadApiKey, loadState, saveApiKey, saveState } from './storage';

function useLatestCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; }, [callback]);
  return useCallback((...args: Args) => latest.current(...args), []);
}

const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0));
interface DraftAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  kind: 'image' | 'document';
  uri: string;
  file?: Blob;
  purpose: FilePurpose;
  remote?: MessageAttachment['remote'];
  status: 'ready' | 'uploading' | 'uploaded' | 'error';
  error?: string;
}
const noAttachments: DraftAttachment[] = [];

function disposeAttachmentCache(attachment: Pick<DraftAttachment, 'uri'>) {
  if (Platform.OS === 'web') {
    if (attachment.uri.startsWith('blob:')) URL.revokeObjectURL(attachment.uri);
  } else if (attachment.uri.startsWith(Paths.cache.uri)) {
    try { const file = new File(attachment.uri); if (file.exists) file.delete(); } catch { /* OS can reclaim picker cache. */ }
  }
}

function useAppController() {
  const [state, setState] = useState<AppState>(emptyState);
  const current = useRef(state);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [saveError, setSaveError] = useState('');
  const [balance, setBalance] = useState<Awaited<ReturnType<typeof getBalance>> | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const accountTask = useRef(false);
  const initializing = useRef(false);
  const persistenceAllowed = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveRevision, setSaveRevision] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, DraftAttachment[]>>({});
  const draftsRef = useRef(drafts);
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  const textDraftsRef = useRef(textDrafts);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const pickingAttachment = useRef(false);

  function setConversationDrafts(id: string, attachments: DraftAttachment[]) {
    const next = { ...draftsRef.current };
    if (attachments.length) next[id] = attachments;
    else delete next[id];
    draftsRef.current = next;
    setDrafts(next);
  }

  function patchDraft(id: string, attachmentId: string, patch: Partial<DraftAttachment>) {
    setConversationDrafts(id, (draftsRef.current[id] ?? []).map(item => item.id === attachmentId ? { ...item, ...patch } : item));
  }

  function setConversationText(id: string, text: string) {
    const next = { ...textDraftsRef.current };
    if (text) next[id] = text;
    else delete next[id];
    textDraftsRef.current = next;
    setTextDrafts(next);
  }
  function setDraftText(text: string) { setConversationText(current.current.activeConversationId ?? 'new', text); }

  function update(fn: (before: AppState) => AppState) {
    const next = fn(current.current);
    if (next === current.current) return;
    current.current = next;
    setState(next);
  }

  async function initialize() {
    if (initializing.current) return;
    initializing.current = true;
    setLoadError('');
    try {
      const [stored, key] = await Promise.all([loadState(), loadApiKey()]);
      // Storage recovers interrupted replies and retains unchanged object references.
      // Cloning every conversation here would force a redundant full rewrite on startup.
      current.current = stored;
      setState(stored);
      setApiKey(key);
      persistenceAllowed.current = true;
      setReady(true);
    } catch {
      setLoadError('本机记录暂时无法读取。为保护已有内容，已停止写入。请先重试；清除数据会删除本机聊天和密钥。');
    } finally { initializing.current = false; }
  }

  useEffect(() => {
    const timer = setTimeout(() => { void initialize(); }, 0);
    return () => { clearTimeout(timer); activeRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!ready || busy) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!persistenceAllowed.current) return;
      void saveState(current.current).then(() => setSaveError('')).catch(() =>
        setSaveError('记录暂未保存成功，请保留当前页面并重试保存。'));
    }, 350);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [state, ready, busy, saveRevision]);
  useEffect(() => {
    if (!ready) return;
    let writing = false;
    const flush = async () => {
      if (writing || !persistenceAllowed.current) return;
      writing = true;
      try { await saveState(current.current); setSaveError(''); }
      catch { setSaveError('记录暂未保存成功，请保留当前页面并重试保存。'); }
      finally { writing = false; }
    };
    // A fixed interval, rather than a debounce, also saves during continuous token output.
    const interval = busy ? setInterval(() => { void flush(); }, 1500) : null;
    const subscription = NativeAppState.addEventListener('change', next => { if (next !== 'active') void flush(); });
    return () => { if (interval) clearInterval(interval); subscription.remove(); };
  }, [ready, busy]);

  const active = state.conversations.find(c => c.id === state.activeConversationId) ?? null;

  function newConversation() {
    if (activeRequest.current) return;
    const id = createId();
    const now = Date.now();
    update(s => ({ ...s, activeConversationId: id, conversations: [
      { id, title: '新的对话', createdAt: now, updatedAt: now, messages: [] }, ...s.conversations,
    ] }));
  }

  function selectConversation(id: string) {
    update(s => s.activeConversationId === id || !s.conversations.some(c => c.id === id)
      ? s : { ...s, activeConversationId: id });
  }
  function renameConversation(id: string, title: string) {
    const value = title.trim().slice(0, 80);
    if (!value) return;
    update(s => ({ ...s, conversations: s.conversations.map(c => c.id === id && c.title !== value ? { ...c, title: value } : c) }));
  }
  function removeConversation(id: string) {
    if (activeRequest.current) return;
    for (const item of draftsRef.current[id] ?? []) disposeAttachmentCache(item);
    setConversationDrafts(id, []);
    setConversationText(id, '');
    update(s => {
      const conversations = s.conversations.filter(c => c.id !== id);
      return { ...s, conversations, activeConversationId: s.activeConversationId === id ? conversations[0]?.id ?? null : s.activeConversationId };
    });
  }
  function changeSettings(settings: Partial<Settings>) {
    update(s => Object.entries(settings).every(([key, value]) => s.settings[key as keyof Settings] === value)
      ? s : { ...s, settings: { ...s.settings, ...settings } });
  }

  async function connect(key: string) {
    if (working || activeRequest.current || accountTask.current) return false;
    accountTask.current = true;
    setWorking(true);
    setNotice('');
    const cleaned = key.trim();
    try {
      const result = await getBalance(cleaned, undefined, expoFetch);
      await saveApiKey(cleaned);
      setApiKey(cleaned);
      setBalance(result);
      setNotice(result.available ? '连接成功，可以开始聊天了。' : '密钥已保存，账户暂无可用余额。');
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '连接失败，请稍后重试。');
      return false;
    } finally { accountTask.current = false; setWorking(false); }
  }
  async function refreshBalance() {
    if (!apiKey || working || accountTask.current) return;
    accountTask.current = true;
    setWorking(true);
    try { setBalance(await getBalance(apiKey, undefined, expoFetch)); }
    catch (error) { setNotice(error instanceof Error ? error.message : '暂时无法查询余额。'); }
    finally { accountTask.current = false; setWorking(false); }
  }
  async function forgetKey() {
    if (activeRequest.current || working || accountTask.current) return;
    accountTask.current = true;
    try {
      await saveApiKey('');
      setApiKey(''); setBalance(null); setNotice('已移除本机 API Key，聊天记录仍然保留。');
    } finally { accountTask.current = false; }
  }

  async function pickAttachments(kind: 'image' | 'file') {
    if (working || activeRequest.current || pickingAttachment.current) return;
    const draftId = current.current.activeConversationId ?? 'new';
    if ((draftsRef.current[draftId]?.length ?? 0) >= ATTACHMENT_LIMITS.perMessage) {
      setNotice(`每条消息最多添加 ${ATTACHMENT_LIMITS.perMessage} 个附件。`); return;
    }
    pickingAttachment.current = true;
    setWorking(true); setNotice('');
    const pending: DraftAttachment[] = [];
    let assets: DocumentPicker.DocumentPickerAsset[] = [];
    try {
      // Called directly from the button to preserve browser user activation.
      const result = await DocumentPicker.getDocumentAsync({
        type: kind === 'image' ? ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] : '*/*',
        multiple: true, copyToCacheDirectory: true, base64: false,
      });
      if (result.canceled) return;
      assets = result.assets;
      if ((draftsRef.current[draftId]?.length ?? 0) + assets.length > ATTACHMENT_LIMITS.perMessage) {
        throw new Error(`每条消息最多添加 ${ATTACHMENT_LIMITS.perMessage} 个附件，请减少选择数量。`);
      }
      for (const asset of assets) {
        const bytes = Platform.OS === 'web' && asset.file ? asset.file.size : new File(asset.uri).size;
        const format = classifyAttachment({ name: asset.name, mimeType: asset.mimeType, bytes });
        pending.push({ id: createId(), name: asset.name, bytes, ...format, uri: asset.uri, file: asset.file, status: 'ready' });
      }
      if (draftId !== 'new' && !current.current.conversations.some(c => c.id === draftId)) {
        throw new Error('这段对话已移除，请在当前对话重新添加附件。');
      }
      setConversationDrafts(draftId, [...(draftsRef.current[draftId] ?? []), ...pending]);
      assets = []; // These cache copies now belong to the draft until send/remove.
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法读取附件，请重新选择。');
    } finally {
      for (const asset of assets) disposeAttachmentCache(asset);
      pickingAttachment.current = false;
      setWorking(false);
    }
  }

  function removeDraftAttachment(id: string) {
    if (activeRequest.current || pickingAttachment.current) return;
    const draftId = current.current.activeConversationId ?? 'new';
    const attachments = draftsRef.current[draftId] ?? [];
    const removed = attachments.find(item => item.id === id);
    if (removed) disposeAttachmentCache(removed);
    setConversationDrafts(draftId, attachments.filter(item => item.id !== id));
    if (removed?.remote) setNotice('已移除草稿附件；之前已上传的原件仍保留在你的 DeepSeek 账户。');
  }

  async function send(content: string, retry = false): Promise<boolean> {
    if (activeRequest.current || working || accountTask.current) return false;
    if (!apiKey) { setNotice('请先在设置中连接你自己的 DeepSeek API Key。'); return false; }
    const conversation = current.current.conversations.find(c => c.id === current.current.activeConversationId);
    const draftId = conversation?.id ?? 'new';
    const picked = retry ? [] : draftsRef.current[draftId] ?? [];
    let text = content.trim();
    let base = conversation?.messages ?? [];
    let attachments: MessageAttachment[] = [];
    if (retry) {
      const last = base.at(-1);
      const previous = base.at(-2);
      if (last?.role !== 'assistant' || !['error', 'stopped'].includes(last.status) || previous?.role !== 'user') return false;
      text = previous.content;
      attachments = previous.attachments ?? [];
      base = base.slice(0, -2);
    }
    if (!text && !picked.length && !attachments.length) return false;
    if (text.length > 40000) { setNotice('单次消息过长，请分段发送（最多 40,000 字符）。'); return false; }
    const settings = { ...current.current.settings };
    if ((picked.length || attachments.length) && settings.model !== 'deepseek-flash') {
      setNotice('图片和文件需要 Flash 模型，请切换到 Flash 后发送。'); return false;
    }
    if (!text) text = '请结合附件内容回答。';
    const conversationId = conversation?.id ?? createId();
    const assistantId = createId();
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true); setNotice('');
    let submitted = false;
    let refused = false;
    let uploadTimedOut = false;
    let uploadingId: string | undefined;
    let output: ReturnType<typeof createStreamBuffer> | undefined;
    function patchMessage(patch: (m: Message) => Message) {
      update(s => ({ ...s, conversations: s.conversations.map(c => {
        if (c.id !== conversationId) return c;
        const index = c.messages.at(-1)?.id === assistantId ? c.messages.length - 1
          : c.messages.findIndex(m => m.id === assistantId);
        if (index < 0) return c;
        const messages = c.messages.slice();
        messages[index] = patch(messages[index]);
        return { ...c, updatedAt: Date.now(), messages };
      }) }));
    }
    try {
      await yieldToUi();
      // Check knowable model/history/expiry limits before any potentially paid
      // upload. Pending IDs exist only in this local dry run, never in state or HTTP.
      const prospectiveAttachments: MessageAttachment[] = [...attachments, ...picked.map(item => ({
        id: item.id, name: item.name, mimeType: item.mimeType, bytes: item.bytes, kind: item.kind,
        remote: item.remote ?? { fileId: `file-api-pending-${item.id}`, purpose: item.purpose, createdAt: Math.floor(Date.now() / 1000) },
      }))];
      buildContextPlan([...base, { id: 'pending-user', role: 'user', content: text, createdAt: Date.now(), status: 'complete',
        ...(prospectiveAttachments.length ? { attachments: prospectiveAttachments } : {}) }], settings);
      if (picked.length) setAttachmentsBusy(true);
      for (const item of picked) {
        if (controller.signal.aborted) throw new Error('已停止上传。');
        uploadingId = item.id;
        let remote = item.remote;
        patchDraft(draftId, item.id, { status: 'uploading', error: undefined });
        // Serial uploads bound memory. Never automatically retry a paid parse.
        const timeoutMs = item.purpose === 'user_data' ? 620000 : 260000;
        const deadline = setTimeout(() => { uploadTimedOut = true; controller.abort(); }, timeoutMs);
        try {
          if (remote) {
            await retrieveDeepSeekFile({ apiKey, fileId: remote.fileId, signal: controller.signal, fetchImpl: expoFetch });
          } else {
            const file = Platform.OS === 'web' ? item.file : new File(item.uri);
            if (!file) throw new Error('找不到附件缓存，请移除后重新选择原文件。');
            const result = await uploadDeepSeekFile({ apiKey, file, fileName: item.name, purpose: item.purpose,
              signal: controller.signal, fetchImpl: expoFetch });
            remote = { fileId: result.id, purpose: result.purpose, createdAt: result.created_at,
              ...(result.expires_at ? { expiresAt: result.expires_at } : {}) };
            // Keep the successful ID before cancellation is checked, so manual retry reuses it.
            patchDraft(draftId, item.id, { remote, status: 'uploaded', error: undefined });
          }
        } finally { clearTimeout(deadline); }
        if (controller.signal.aborted) throw new Error('已停止上传。');
        attachments.push({ id: item.id, name: item.name, mimeType: item.mimeType, bytes: item.bytes, kind: item.kind, remote });
        patchDraft(draftId, item.id, { status: 'uploaded', error: undefined });
        uploadingId = undefined;
      }
      setAttachmentsBusy(false);
      const now = Date.now();
      const user: Message = { id: createId(), role: 'user', content: text, createdAt: now, status: 'complete',
        ...(attachments.length ? { attachments } : {}) };
      const requestMessages = [...base, user];
      const plan = buildContextPlan(requestMessages, settings);
      if (controller.signal.aborted) throw new Error('已停止发送。');
      const assistant: Message = { id: assistantId, role: 'assistant', content: '', reasoning: '', createdAt: now,
        status: 'streaming', contextUsage: plan.usage };
      const nextMessages = [...requestMessages, assistant];
      update(s => conversation ? { ...s, conversations: s.conversations.map(c => c.id === conversationId
        ? { ...c, title: c.messages.length ? c.title : text.slice(0, 24), updatedAt: now, messages: nextMessages } : c) }
        : { ...s, activeConversationId: s.activeConversationId ?? conversationId, conversations: [
          { id: conversationId, title: text.slice(0, 24), createdAt: now, updatedAt: now, messages: nextMessages }, ...s.conversations,
        ] });
      submitted = true;
      if (!retry) {
        setConversationDrafts(draftId, []);
        if (textDraftsRef.current[draftId] === content) setConversationText(draftId, '');
        for (const item of picked) disposeAttachmentCache(item);
      }
      output = createStreamBuffer(delta => {
        if (delta.refused) {
          refused = true;
          patchMessage(m => ({ ...m, content: '这次内容未通过服务方安全检查。可以换个话题继续聊。', reasoning: '', status: 'refused', contextEligible: false }));
        } else if (!refused) {
          patchMessage(m => ({ ...m, content: m.content + (delta.content ?? ''), reasoning: (m.reasoning ?? '') + (delta.reasoning ?? '') }));
        }
      });
      // Persist the question and remote references before a billable chat request.
      await yieldToUi();
      await saveState(current.current);
      const result = await streamChat({ apiKey, messages: requestMessages, settings,
        signal: controller.signal, fetchImpl: expoFetch, onDelta: output.push });
      output.flush();
      if (!refused) patchMessage(m => ({ ...m, status: result.finishReason === 'length' ? 'stopped' : 'complete', contextEligible: result.finishReason !== 'length' }));
      if (result.finishReason === 'length') setNotice('本次回复达到输出上限。你可以另发一条消息继续提问。');
    } catch (error) {
      output?.flush();
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const explanation = uploadTimedOut
        ? '附件上传或解析等待超时。官方后台可能仍在处理，重试前请留意账户文件和费用。'
        : cancelled && !submitted
          ? '已停止等待，草稿仍保留。已开始的官方文件解析可能继续完成并计费，重试前请留意。'
          : error instanceof Error ? error.message : '发送未完成，请稍后重试。';
      if (!submitted) {
        if (uploadingId) patchDraft(draftId, uploadingId, { status: 'error', error: explanation });
        setNotice(explanation);
      } else if (!refused) {
        patchMessage(m => ({ ...m, status: cancelled ? 'stopped' : 'error', contextEligible: false,
          error: cancelled ? undefined : explanation }));
      }
    } finally {
      output?.dispose();
      activeRequest.current = null; setBusy(false); setAttachmentsBusy(false);
      if (submitted) {
        try { await saveState(current.current); setSaveError(''); }
        catch { setSaveError('记录暂未保存成功，请重试保存。'); }
      }
    }
    return submitted;
  }

  async function pickHistory() {
    if (working || activeRequest.current) return;
    setWorking(true); setNotice('');
    let cached: File | undefined;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream', 'text/plain'], copyToCacheDirectory: true });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset.size !== undefined) checkHistoryInputSize(asset.size);
      let bytes: Uint8Array;
      if (Platform.OS === 'web' && asset.file) bytes = new Uint8Array(await asset.file.arrayBuffer());
      else { cached = new File(asset.uri); bytes = await cached.bytes(); }
      setPreview(parseHistory(bytes, asset.name));
    } catch (error) { setNotice(error instanceof Error ? error.message : '导入失败，原记录未改动。'); }
    finally {
      // The picker owns this cache copy, not the user's original file.
      if (cached?.uri.startsWith(Paths.cache.uri)) { try { await cached.delete(); } catch { /* cache cleanup can retry at OS level */ } }
      setWorking(false);
    }
  }
  function confirmImport() {
    if (!preview || activeRequest.current) return;
    const merged = mergeConversations(current.current.conversations, preview.conversations);
    try {
      // Do not accept an import which cannot subsequently be exported and restored.
      exportHistory({ ...current.current, conversations: merged.conversations });
    } catch {
      setPreview(null);
      setNotice(`合并后的记录未通过备份检查（容量上限 ${HISTORY_FILE_LIMIT_LABEL}），尚未导入。请先备份并分批整理对话。`);
      return;
    }
    update(s => ({ ...s, conversations: merged.conversations, activeConversationId: s.activeConversationId ?? merged.conversations[0]?.id ?? null }));
    setPreview(null); setNotice(`已导入 ${merged.added} 个对话，保留已有记录，跳过 ${merged.skipped} 个重复对话。`);
  }
  async function backup() {
    if (working || activeRequest.current) return;
    setWorking(true);
    try {
      await yieldToUi();
      const data = exportHistory(current.current);
      const filename = `shiyu-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      if (Platform.OS === 'web') {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } else {
        // Save directly to a user-selected folder. A share-sheet return does not
        // guarantee that another app has finished reading a temporary attachment.
        const target = await Directory.pickDirectoryAsync();
        const file = target.createFile(filename, 'application/json');
        try { await file.write(data); }
        catch (error) { try { file.delete(); } catch { /* best effort for a new, incomplete file */ } throw error; }
        setNotice('备份已保存到你选择的文件夹，请妥善保管。');
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : '备份失败，请重试。'); }
    finally { setWorking(false); }
  }
  async function clearAll() {
    if (activeRequest.current || working || accountTask.current || initializing.current) return;
    accountTask.current = true;
    persistenceAllowed.current = false;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setReady(false);
    try {
      await deleteAllLocalData();
      for (const items of Object.values(draftsRef.current)) for (const item of items) disposeAttachmentCache(item);
      draftsRef.current = {}; setDrafts({});
      textDraftsRef.current = {}; setTextDrafts({});
      const next = emptyState(); current.current = next; setState(next);
      setApiKey(''); setBalance(null); setPreview(null); setSaveError(''); setLoadError('');
      persistenceAllowed.current = true;
      setReady(true); setNotice('本机聊天和密钥已清除。');
    } catch { setLoadError('清除未完成，请重试。'); }
    finally { accountTask.current = false; }
  }
  return { state, active, ready, loadError, apiKey, busy, working, notice, setNotice,
    draftAttachments: drafts[state.activeConversationId ?? 'new'] ?? noAttachments, attachmentsBusy,
    draftText: textDrafts[state.activeConversationId ?? 'new'] ?? '', setDraftText: useLatestCallback(setDraftText),
    pickAttachments: useLatestCallback(pickAttachments),
    removeDraftAttachment: useLatestCallback(removeDraftAttachment),
    saveError, retrySave: useCallback(() => setSaveRevision(v => v + 1), []), balance, preview, setPreview,
    initialize: useLatestCallback(initialize),
    newConversation: useLatestCallback(newConversation),
    selectConversation: useLatestCallback(selectConversation),
    renameConversation: useLatestCallback(renameConversation),
    removeConversation: useLatestCallback(removeConversation),
    changeSettings: useLatestCallback(changeSettings),
    connect: useLatestCallback(connect),
    refreshBalance: useLatestCallback(refreshBalance),
    forgetKey: useLatestCallback(forgetKey),
    send: useLatestCallback(send),
    stop: useCallback(() => activeRequest.current?.abort(), []),
    pickHistory: useLatestCallback(pickHistory),
    confirmImport: useLatestCallback(confirmImport),
    backup: useLatestCallback(backup),
    clearAll: useLatestCallback(clearAll) };
}

type Controller = ReturnType<typeof useAppController>;
const AppContext = createContext<Controller | null>(null);
export function AppProvider({ children }: { children: React.ReactNode }) {
  const controller = useAppController();
  return <AppContext.Provider value={controller}>{children}</AppContext.Provider>;
}
export function useChatApp(): Controller {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppProvider is required');
  return value;
}
