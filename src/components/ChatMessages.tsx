import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, VirtualizedList,
  type ListRenderItemInfo, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Markdown from 'react-native-markdown-display';
import type { Message } from '../core/types';

const colors = { ink: '#253C36', muted: '#738079', green: '#315C4C', line: '#E5E9E2' };
const getItem = (messages: Message[], index: number): Message => messages[messages.length - 1 - index];
const getItemCount = (messages: Message[]): number => messages.length;
const keyExtractor = (message: Message): string => message.id;
const maintainPosition = { minIndexForVisible: 0 };
const markdownRules = { image: () => null };
const LATEST_THRESHOLD = 72;

interface Props {
  messages: Message[];
  busy: boolean;
  actionsDisabled: boolean;
  wide: boolean;
  /** Changed only by an explicit send/retry action, not by arriving tokens. */
  followRequest: number;
  onCopy: (content: string) => void;
  onLink: (url: string) => void;
  onRetry: (userContent: string) => void;
  onDeleteMessages: (ids: string[], onDeleted?: () => void) => void;
}

/**
 * Index zero is the newest message. An inverted virtual list opens at the latest
 * content immediately, without measuring or mounting an entire imported history.
 * getItem reverses indexing without allocating a reversed array on every token.
 */
const ChatMessages = memo(function ChatMessages({ messages, busy, actionsDisabled, wide, followRequest, onCopy, onLink, onRetry, onDeleteMessages }: Props) {
  const list = useRef<InstanceType<typeof VirtualizedList>>(null);
  const following = useRef(true);
  const dragging = useRef(false);
  const scrollOffset = useRef(0);
  const contentHeight = useRef(0);
  const pendingWebAnchor = useRef(false);
  const frame = useRef<number | null>(null);
  const jumpVisible = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const latest = messages[messages.length - 1];
  const previous = messages[messages.length - 2];
  const retryText = !busy && !actionsDisabled && latest?.role === 'assistant' && !latest.contextBoundaryBefore && ['error', 'stopped'].includes(latest.status)
    && previous?.role === 'user' ? previous.content : undefined;
  const clearSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);
  const toggleSelection = useCallback((id: string) => {
    if (actionsDisabled) return;
    setSelectedIds(before => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, [actionsDisabled]);
  const deleteSingle = useCallback((id: string) => {
    if (!actionsDisabled) onDeleteMessages([id]);
  }, [actionsDisabled, onDeleteMessages]);
  const allSelected = selectedIds.size === messages.length;
  const listState = useMemo(() => ({ selectionMode, selectedIds, retryText, actionsDisabled }), [selectionMode, selectedIds, retryText, actionsDisabled]);

  const showJump = useCallback((visible: boolean) => {
    if (jumpVisible.current === visible) return;
    jumpVisible.current = visible;
    setShowLatest(visible);
  }, []);

  const scheduleFollow = useCallback(() => {
    if (!following.current || dragging.current || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (following.current && !dragging.current) {
        list.current?.scrollToOffset({ offset: 0, animated: false });
      }
    });
  }, []);

  const goLatest = useCallback(() => {
    following.current = true;
    dragging.current = false;
    pendingWebAnchor.current = false;
    scrollOffset.current = 0;
    showJump(false);
    list.current?.scrollToOffset({ offset: 0, animated: false });
    scheduleFollow();
  }, [scheduleFollow, showJump]);

  useLayoutEffect(() => { goLatest(); }, [followRequest, goLatest]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  useLayoutEffect(() => {
    // RNWeb does not implement native maintainVisibleContentPosition. Only
    // compensate a growing newest row, not measurements of older virtual cells.
    pendingWebAnchor.current = Platform.OS === 'web' && !following.current;
  }, [latest?.id, latest?.content, latest?.reasoning, latest?.attachments, latest?.contextUsage]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = Math.max(0, event.nativeEvent.contentOffset.y);
    scrollOffset.current = offset;
    const atLatest = offset <= LATEST_THRESHOLD;
    following.current = atLatest;
    showJump(!atLatest);
  }, [showJump]);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    const growth = height - contentHeight.current;
    const hadLayout = contentHeight.current > 0;
    contentHeight.current = height;
    if (following.current) scheduleFollow();
    else if (pendingWebAnchor.current && hadLayout && growth !== 0) {
      const offset = Math.max(0, scrollOffset.current + growth);
      scrollOffset.current = offset;
      list.current?.scrollToOffset({ offset, animated: false });
    }
    pendingWebAnchor.current = false;
  }, [scheduleFollow]);

  const renderItem = useCallback(({ item, index }: ListRenderItemInfo<Message>) => (
    <MessageBubble message={item} onCopy={onCopy} onLink={onLink} onRetry={onRetry}
      retryText={index === 0 ? retryText : undefined} actionsDisabled={actionsDisabled}
      selectionMode={selectionMode} selected={selectedIds.has(item.id)} onToggleSelection={toggleSelection} onDelete={deleteSingle} />
  ), [onCopy, onLink, onRetry, retryText, actionsDisabled, selectionMode, selectedIds, toggleSelection, deleteSingle]);

  return <View style={styles.container}>
    <View testID="message-selection-toolbar" style={[styles.selectionToolbar, wide ? styles.widePadding : styles.phonePadding]}>
      {selectionMode ? <>
        <Text style={styles.selectionCount}>已选 {selectedIds.size} 条</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={allSelected ? '取消全选' : '全选消息'} disabled={actionsDisabled}
          onPress={() => setSelectedIds(allSelected ? new Set() : new Set(messages.map(message => message.id)))}
          style={[styles.toolbarButton, actionsDisabled && styles.disabled]}><Text style={styles.toolbarLabel}>{allSelected ? '取消全选' : '全选'}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="取消选择" disabled={actionsDisabled} onPress={clearSelection}
          style={[styles.toolbarButton, actionsDisabled && styles.disabled]}><Text style={styles.toolbarLabel}>取消</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="删除选中消息" disabled={actionsDisabled || !selectedIds.size}
          onPress={() => onDeleteMessages([...selectedIds], clearSelection)}
          style={[styles.toolbarButton, styles.deleteSelected, (actionsDisabled || !selectedIds.size) && styles.disabled]}>
          <Feather name="trash-2" size={14} color="#A45A44" /><Text style={styles.deleteLabel}>删除选中</Text>
        </Pressable>
      </> : <Pressable accessibilityRole="button" accessibilityLabel="选择消息" disabled={actionsDisabled} onPress={() => setSelectionMode(true)}
        style={[styles.toolbarButton, actionsDisabled && styles.disabled]}><Feather name="check-square" size={15} color={colors.green} /><Text style={styles.toolbarLabel}>选择消息</Text></Pressable>}
    </View>
    <VirtualizedList
      ref={list}
      testID="chat-messages"
      data={messages}
      getItem={getItem}
      getItemCount={getItemCount}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      extraData={listState}
      inverted
      style={styles.container}
      contentContainerStyle={[styles.messages, wide ? styles.widePadding : styles.phonePadding]}
      initialNumToRender={8}
      maxToRenderPerBatch={6}
      updateCellsBatchingPeriod={50}
      windowSize={7}
      // Windowing still unmounts distant rows. Avoid native clipping bugs with
      // inverted transforms and variable-height Markdown/thinking blocks.
      removeClippedSubviews={false}
      maintainVisibleContentPosition={Platform.OS === 'web' ? undefined : maintainPosition}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      scrollEventThrottle={32}
      onScroll={onScroll}
      onScrollBeginDrag={() => { dragging.current = true; following.current = false; }}
      onScrollEndDrag={() => { dragging.current = false; scheduleFollow(); }}
      onMomentumScrollEnd={() => { dragging.current = false; scheduleFollow(); }}
      onContentSizeChange={onContentSizeChange}
      onLayout={scheduleFollow}
    />
    {showLatest && <Pressable accessibilityRole="button" accessibilityLabel="回到最新" onPress={goLatest} style={styles.latestButton}>
      <Feather name="arrow-down" size={16} color={colors.green} /><Text style={styles.latestLabel}>回到最新</Text>
    </Pressable>}
  </View>;
});

export default ChatMessages;

/** Thinking toggles or unchanged content must not rerun the Markdown parser. */
const MarkdownContent = memo(function MarkdownContent({ content, onLink }: { content: string; onLink: Props['onLink'] }) {
  const onLinkPress = useCallback((url: string) => {
    if (/^https:\/\//i.test(url)) onLink(url);
    return false;
  }, [onLink]);
  return <Markdown style={markdownStyles} onLinkPress={onLinkPress} rules={markdownRules}>{content}</Markdown>;
});

const MessageBubble = memo(function MessageBubble({ message, onCopy, onLink, onRetry, retryText, actionsDisabled, selectionMode, selected, onToggleSelection, onDelete }: {
  message: Message; onCopy: Props['onCopy']; onLink: Props['onLink']; onRetry: Props['onRetry']; retryText?: string;
  actionsDisabled: boolean; selectionMode: boolean; selected: boolean;
  onToggleSelection: (id: string) => void; onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isUser = message.role === 'user';
  return <View testID={`chat-message-${message.id}`} style={[styles.messageRow, isUser && styles.userRow]}>
    <View style={[styles.messageBody, isUser && styles.userRow]} pointerEvents={selectionMode ? 'none' : 'auto'}
      accessibilityElementsHidden={selectionMode} importantForAccessibility={selectionMode ? 'no-hide-descendants' : 'auto'}>
    {!isUser && <View style={styles.assistantLabel}><View style={styles.smallMark}><Feather name="feather" size={14} color="#fff" /></View><Text style={styles.small}>DeepSeek</Text><Text style={styles.tiny}>· AI 生成</Text></View>}
    <View style={[styles.bubble, isUser && styles.userBubble]}>
      {!!message.attachments?.length && <View style={styles.attachments}>
        {message.attachments.map(attachment => <View key={attachment.id} testID={`message-attachment-${attachment.id}`} style={styles.attachmentCard}>
          <Feather name={attachment.kind === 'image' ? 'image' : 'file-text'} size={22} color={colors.green} />
          <View style={styles.attachmentDescription}><Text style={styles.attachmentName} numberOfLines={2}>{attachment.name}</Text>
            <Text style={styles.tiny}>{attachment.kind === 'image' ? '图片' : '文件'} · {formatAttachmentSize(attachment.bytes)}</Text>
            <Text style={styles.tiny}>保存在 DeepSeek 账户</Text>
          </View>
        </View>)}
      </View>}
      {!!message.reasoning && !isUser && <View style={styles.reasoning}>
        <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起思考过程' : '展开思考过程'} accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.reasoningToggle}>
          <Feather name="aperture" size={14} color={colors.green} /><Text style={styles.small}>{message.status === 'streaming' && !message.content ? '正在思考…' : '思考过程'}</Text><Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.green} />
        </Pressable>
        {expanded && <Text selectable style={styles.reasoningText}>{message.reasoning}</Text>}
      </View>}
      {isUser ? <Text selectable style={styles.messageText}>{message.content}</Text>
        : message.content ? <MarkdownContent content={message.content} onLink={onLink} />
          : message.status === 'streaming' ? <View style={styles.typing}><ActivityIndicator size="small" color={colors.green} /><Text style={styles.small}>在认真听你说…</Text></View>
            : <Text style={styles.small}>{message.status === 'stopped' ? '已停止生成' : '暂时没有收到回复'}</Text>}
      {!!message.error && <Text style={styles.errorText}>{message.error}</Text>}
      {message.status === 'stopped' && !!message.content && <Text style={styles.tiny}>回复已停止 · 这段未完成的回复不会带入后续上下文</Text>}
      {!isUser && message.contextUsage && <View testID={`message-context-${message.id}`} style={styles.contextInfo}>
        <View style={styles.contextLabel}><Feather name="layers" size={12} color={colors.muted} /><Text style={styles.tiny}>本次携带 {message.contextUsage.includedHistoryMessages} 条历史</Text></View>
        {message.contextUsage.omittedHistoryMessages > 0 && <Text style={styles.contextWarning}>{message.contextUsage.omittedHistoryMessages} 条较早消息未发送{message.contextUsage.reason === 'message_limit' ? '（按当前条数设置）' : message.contextUsage.reason === 'token_budget' ? '（超出本次上下文容量）' : ''}。原记录仍保存在本机。</Text>}
        {message.contextUsage.truncated && message.contextUsage.omittedHistoryMessages === 0 && <Text style={styles.contextWarning}>本次上下文达到携带上限，原记录仍保存在本机。</Text>}
      </View>}
    </View>
    <View style={[styles.messageActions, selectionMode && styles.invisible]}>
      {!isUser && message.status !== 'streaming' && !!message.content && <Pressable accessibilityRole="button" accessibilityLabel="复制回复" onPress={() => onCopy(message.content)} style={styles.iconButton}><Feather name="copy" size={18} color={colors.green} /></Pressable>}
      {retryText !== undefined && <Pressable accessibilityRole="button" accessibilityLabel="重新生成（将消耗 API）" disabled={actionsDisabled} onPress={() => onRetry(retryText)} style={styles.retry}><Feather name="rotate-cw" size={14} color={colors.green} /><Text style={styles.tiny}>重新生成（将消耗 API）</Text></Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="删除此消息" disabled={actionsDisabled} onPress={() => onDelete(message.id)} style={[styles.deleteMessage, actionsDisabled && styles.disabled]}>
        <Feather name="trash-2" size={14} color={colors.muted} /><Text style={styles.tiny}>删除</Text>
      </Pressable>
    </View>
    </View>
    {selectionMode && <Pressable testID={`select-message-${message.id}`} accessibilityRole="checkbox" accessibilityLabel="选择此消息"
      accessibilityHint={`${isUser ? '我的消息' : 'DeepSeek 回复'}：${message.content.slice(0, 80) || '附件消息'}`}
      aria-checked={selected} aria-disabled={actionsDisabled} disabled={actionsDisabled} onPress={() => onToggleSelection(message.id)}
      style={[styles.selectionOverlay, selected && styles.selectedOverlay]}>
      <View style={styles.checkboxMark}><Feather name={selected ? 'check-circle' : 'circle'} size={22} color={colors.green} /></View>
    </Pressable>}
  </View>;
});

function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const markdownStyles = StyleSheet.create({ body: { fontSize: 16, color: colors.ink, lineHeight: 27 }, paragraph: { marginTop: 0, marginBottom: 10 }, code_inline: { backgroundColor: '#EDF0EB', color: colors.ink }, fence: { backgroundColor: '#EFF2EC', borderColor: colors.line, color: colors.ink, borderRadius: 8, padding: 12 }, link: { color: colors.green }, heading1: { fontSize: 23, lineHeight: 32 }, heading2: { fontSize: 20, lineHeight: 29 }, table: { borderColor: colors.line }, tr: { borderColor: colors.line } });
const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
  selectionToolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 4, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.line, width: '100%', maxWidth: 920, alignSelf: 'center' },
  toolbarButton: { minHeight: 36, paddingHorizontal: 9, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 8 }, toolbarLabel: { fontSize: 12, color: colors.green }, selectionCount: { marginRight: 'auto', fontSize: 12, color: colors.ink, fontWeight: '600' }, deleteSelected: { backgroundColor: '#F8ECE6' }, deleteLabel: { fontSize: 12, color: '#A45A44' }, disabled: { opacity: 0.4 }, invisible: { opacity: 0 },
  messages: { paddingVertical: 20, maxWidth: 920, alignSelf: 'center', width: '100%' },
  widePadding: { paddingHorizontal: 36 }, phonePadding: { paddingHorizontal: 18 },
  latestButton: { position: 'absolute', bottom: 12, alignSelf: 'center', flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: '#FFFFFF', borderColor: colors.line, borderWidth: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 11, elevation: 3, boxShadow: '0 2px 10px rgba(38,65,45,0.1)' },
  latestLabel: { fontSize: 12, color: colors.green, fontWeight: '600' },
  messageRow: { marginBottom: 25, alignItems: 'flex-start' }, messageBody: { width: '100%', alignItems: 'flex-start' }, userRow: { alignItems: 'flex-end' },
  selectionOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 12, borderWidth: 1, borderColor: colors.line }, selectedOverlay: { borderColor: '#8CAB8F', backgroundColor: 'rgba(100, 145, 105, 0.06)' }, checkboxMark: { position: 'absolute', right: 10, bottom: 9, backgroundColor: '#FAF9F6', borderRadius: 12 }, deleteMessage: { minHeight: 40, paddingHorizontal: 10, paddingVertical: 10, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center' },
  assistantLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }, smallMark: { width: 26, height: 26, borderRadius: 9, backgroundColor: colors.green, justifyContent: 'center', alignItems: 'center' },
  bubble: { maxWidth: '100%', width: '100%' }, userBubble: { backgroundColor: '#EAF0E6', width: 'auto', maxWidth: '88%', borderRadius: 18, borderTopRightRadius: 5, paddingVertical: 12, paddingHorizontal: 17 }, messageText: { fontSize: 16, lineHeight: 27, color: colors.ink },
  reasoning: { backgroundColor: '#F0F2EC', borderRadius: 10, padding: 10, marginBottom: 12 }, reasoningToggle: { flexDirection: 'row', gap: 9, alignItems: 'center' }, reasoningText: { color: '#738076', fontSize: 13, lineHeight: 23, marginTop: 10 },
  attachments: { gap: 8, marginBottom: 10 }, attachmentCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 10, backgroundColor: '#F8FAF6', borderWidth: 1, borderColor: colors.line, width: 260, maxWidth: '100%' }, attachmentDescription: { flex: 1, minWidth: 0, gap: 2 }, attachmentName: { fontSize: 12, lineHeight: 19, color: colors.ink, fontWeight: '600' }, contextInfo: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.line, gap: 3 }, contextLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 }, contextWarning: { fontSize: 10, lineHeight: 17, color: '#93754C' },
  typing: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 10 }, messageActions: { flexDirection: 'row', alignItems: 'center' }, retry: { flexDirection: 'row', gap: 6, alignItems: 'center', padding: 9 }, iconButton: { padding: 10, minWidth: 40, minHeight: 40, justifyContent: 'center', alignItems: 'center' },
  small: { fontSize: 12, lineHeight: 21, color: colors.muted }, tiny: { fontSize: 10, lineHeight: 17, color: colors.muted }, errorText: { color: '#A45A44', fontSize: 13, lineHeight: 23 },
});
