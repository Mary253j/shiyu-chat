import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState as NativeAppState, Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { AppState, createId, emptyState, Message, Settings } from '../core/types';
import { getBalance, streamChat } from '../core/deepseek';
import { createStreamBuffer } from '../core/streamBuffer';
import { exportHistory, mergeConversations, parseHistory, ImportPreview } from '../core/history';
import { deleteAllLocalData, loadApiKey, loadState, saveApiKey, saveState } from './storage';

function useLatestCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; }, [callback]);
  return useCallback((...args: Args) => latest.current(...args), []);
}

const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0));

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

  useEffect(() => { void initialize(); return () => activeRequest.current?.abort(); }, []);
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

  async function send(content: string, retry = false) {
    if (activeRequest.current || working || accountTask.current) return;
    if (!apiKey) { setNotice('请先在设置中连接你自己的 DeepSeek API Key。'); return; }
    const text = content.trim();
    if (!text) return;
    if (text.length > 40000) { setNotice('单次消息过长，请分段发送（最多 40,000 字符）。'); return; }
    let conversation = current.current.conversations.find(c => c.id === current.current.activeConversationId);
    if (!conversation) {
      newConversation();
      conversation = current.current.conversations.find(c => c.id === current.current.activeConversationId)!;
    }
    const conversationId = conversation.id;
    let base = conversation.messages;
    if (retry) {
      const last = base.at(-1);
      if (last?.role === 'assistant' && ['error', 'stopped'].includes(last.status) && base.at(-2)?.role === 'user') base = base.slice(0, -2);
      else return;
    }
    const now = Date.now();
    const user: Message = { id: createId(), role: 'user', content: text, createdAt: now, status: 'complete' };
    const assistantId = createId();
    const assistant: Message = { id: assistantId, role: 'assistant', content: '', reasoning: '', createdAt: now, status: 'streaming' };
    const requestMessages = [...base, user];
    update(s => ({ ...s, conversations: s.conversations.map(c => c.id === conversationId ? {
      ...c, title: c.messages.length ? c.title : text.slice(0, 24), updatedAt: now, messages: [...requestMessages, assistant],
    } : c) }));
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true); setNotice('');
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
    let refused = false;
    const output = createStreamBuffer(delta => {
      if (delta.refused) {
        refused = true;
        patchMessage(m => ({ ...m, content: '这次内容未通过服务方安全检查。可以换个话题继续聊。', reasoning: '', status: 'refused', contextEligible: false }));
      } else if (!refused) {
        patchMessage(m => ({ ...m, content: m.content + (delta.content ?? ''), reasoning: (m.reasoning ?? '') + (delta.reasoning ?? '') }));
      }
    });
    try {
      // Persist the question before making a potentially billable request.
      await yieldToUi();
      await saveState(current.current);
      const result = await streamChat({ apiKey, messages: requestMessages, settings: current.current.settings,
        signal: controller.signal, fetchImpl: expoFetch,
        onDelta: output.push,
      });
      output.flush();
      if (!refused) patchMessage(m => ({ ...m, status: result.finishReason === 'length' ? 'stopped' : 'complete', contextEligible: result.finishReason !== 'length' }));
      if (result.finishReason === 'length') setNotice('本次回复达到输出上限。你可以另发一条消息继续提问。');
    } catch (error) {
      output.flush();
      if (!refused) {
        const cancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        patchMessage(m => ({ ...m, status: cancelled ? 'stopped' : 'error', contextEligible: false,
          error: cancelled ? undefined : error instanceof Error ? error.message : '回复中断，请稍后重试。' }));
      }
    } finally {
      output.dispose();
      activeRequest.current = null; setBusy(false);
      try { await saveState(current.current); setSaveError(''); } catch { setSaveError('记录暂未保存成功，请重试保存。'); }
    }
  }

  async function pickHistory() {
    if (working || activeRequest.current) return;
    setWorking(true); setNotice('');
    let cached: File | undefined;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream', 'text/plain'], copyToCacheDirectory: true });
      if (result.canceled) return;
      const asset = result.assets[0];
      if ((asset.size ?? 0) > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请分批导入。');
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
      setNotice('合并后的记录超过本版 20 MB 备份容量，尚未导入。请先备份并分批整理对话。');
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
      const next = emptyState(); current.current = next; setState(next);
      setApiKey(''); setBalance(null); setPreview(null); setSaveError(''); setLoadError('');
      persistenceAllowed.current = true;
      setReady(true); setNotice('本机聊天和密钥已清除。');
    } catch { setLoadError('清除未完成，请重试。'); }
    finally { accountTask.current = false; }
  }
  return { state, active, ready, loadError, apiKey, busy, working, notice, setNotice,
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
