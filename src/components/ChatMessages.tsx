import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  wide: boolean;
  /** Changed only by an explicit send/retry action, not by arriving tokens. */
  followRequest: number;
  onCopy: (content: string) => void;
  onLink: (url: string) => void;
  onRetry: (userContent: string) => void;
}

/**
 * Index zero is the newest message. An inverted virtual list opens at the latest
 * content immediately, without measuring or mounting an entire imported history.
 * getItem reverses indexing without allocating a reversed array on every token.
 */
const ChatMessages = memo(function ChatMessages({ messages, busy, wide, followRequest, onCopy, onLink, onRetry }: Props) {
  const list = useRef<InstanceType<typeof VirtualizedList>>(null);
  const following = useRef(true);
  const dragging = useRef(false);
  const scrollOffset = useRef(0);
  const contentHeight = useRef(0);
  const pendingWebAnchor = useRef(false);
  const frame = useRef<number | null>(null);
  const jumpVisible = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const latest = messages[messages.length - 1];
  const previous = messages[messages.length - 2];
  const retryText = !busy && latest?.role === 'assistant' && ['error', 'stopped'].includes(latest.status)
    && previous?.role === 'user' ? previous.content : undefined;

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
  }, [latest?.id, latest?.content, latest?.reasoning]);

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
      retryText={index === 0 ? retryText : undefined} />
  ), [onCopy, onLink, onRetry, retryText]);

  return <View style={styles.container}>
    <VirtualizedList
      ref={list}
      testID="chat-messages"
      data={messages}
      getItem={getItem}
      getItemCount={getItemCount}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      extraData={retryText}
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

const MessageBubble = memo(function MessageBubble({ message, onCopy, onLink, onRetry, retryText }: {
  message: Message; onCopy: Props['onCopy']; onLink: Props['onLink']; onRetry: Props['onRetry']; retryText?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isUser = message.role === 'user';
  return <View testID={`chat-message-${message.id}`} style={[styles.messageRow, isUser && styles.userRow]}>
    {!isUser && <View style={styles.assistantLabel}><View style={styles.smallMark}><Feather name="feather" size={14} color="#fff" /></View><Text style={styles.small}>DeepSeek</Text><Text style={styles.tiny}>· AI 生成</Text></View>}
    <View style={[styles.bubble, isUser && styles.userBubble]}>
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
    </View>
    {!isUser && message.status !== 'streaming' && <View style={styles.messageActions}>
      {!!message.content && <Pressable accessibilityRole="button" accessibilityLabel="复制回复" onPress={() => onCopy(message.content)} style={styles.iconButton}><Feather name="copy" size={18} color={colors.green} /></Pressable>}
      {retryText !== undefined && <Pressable accessibilityRole="button" accessibilityLabel="重新生成（将消耗 API）" onPress={() => onRetry(retryText)} style={styles.retry}><Feather name="rotate-cw" size={14} color={colors.green} /><Text style={styles.tiny}>重新生成（将消耗 API）</Text></Pressable>}
    </View>}
  </View>;
});

const markdownStyles = StyleSheet.create({ body: { fontSize: 16, color: colors.ink, lineHeight: 27 }, paragraph: { marginTop: 0, marginBottom: 10 }, code_inline: { backgroundColor: '#EDF0EB', color: colors.ink }, fence: { backgroundColor: '#EFF2EC', borderColor: colors.line, color: colors.ink, borderRadius: 8, padding: 12 }, link: { color: colors.green }, heading1: { fontSize: 23, lineHeight: 32 }, heading2: { fontSize: 20, lineHeight: 29 }, table: { borderColor: colors.line }, tr: { borderColor: colors.line } });
const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
  messages: { paddingVertical: 20, maxWidth: 920, alignSelf: 'center', width: '100%' },
  widePadding: { paddingHorizontal: 36 }, phonePadding: { paddingHorizontal: 18 },
  latestButton: { position: 'absolute', bottom: 12, alignSelf: 'center', flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: '#FFFFFF', borderColor: colors.line, borderWidth: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 11, elevation: 3, boxShadow: '0 2px 10px rgba(38,65,45,0.1)' },
  latestLabel: { fontSize: 12, color: colors.green, fontWeight: '600' },
  messageRow: { marginBottom: 25, alignItems: 'flex-start' }, userRow: { alignItems: 'flex-end' },
  assistantLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }, smallMark: { width: 26, height: 26, borderRadius: 9, backgroundColor: colors.green, justifyContent: 'center', alignItems: 'center' },
  bubble: { maxWidth: '100%', width: '100%' }, userBubble: { backgroundColor: '#EAF0E6', width: 'auto', maxWidth: '88%', borderRadius: 18, borderTopRightRadius: 5, paddingVertical: 12, paddingHorizontal: 17 }, messageText: { fontSize: 16, lineHeight: 27, color: colors.ink },
  reasoning: { backgroundColor: '#F0F2EC', borderRadius: 10, padding: 10, marginBottom: 12 }, reasoningToggle: { flexDirection: 'row', gap: 9, alignItems: 'center' }, reasoningText: { color: '#738076', fontSize: 13, lineHeight: 23, marginTop: 10 },
  typing: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 10 }, messageActions: { flexDirection: 'row', alignItems: 'center' }, retry: { flexDirection: 'row', gap: 6, alignItems: 'center', padding: 9 }, iconButton: { padding: 10, minWidth: 40, minHeight: 40, justifyContent: 'center', alignItems: 'center' },
  small: { fontSize: 12, lineHeight: 21, color: colors.muted }, tiny: { fontSize: 10, lineHeight: 17, color: colors.muted }, errorText: { color: '#A45A44', fontSize: 13, lineHeight: 23 },
});
