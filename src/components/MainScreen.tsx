import React, { memo, useCallback, useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, TextInput, useWindowDimensions, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useChatApp } from '../services/AppProvider';
import { Conversation, Message } from '../core/types';
import SupportPanel from './SupportPanel';
import ChatMessages from './ChatMessages';

type Page = 'chat' | 'library' | 'settings' | 'support';
type IconName = React.ComponentProps<typeof Feather>['name'];
const colors = { bg: '#FAF9F6', paper: '#FFFFFF', ink: '#253C36', muted: '#738079', green: '#315C4C', pale: '#EDF3EE', line: '#E5E9E2', warm: '#F3EBDD' };
const routes = { chat: '/', library: '/library', settings: '/settings', support: '/support' } as const;
const emptyMessages: Message[] = [];
const nav: { page: Page; label: string; icon: IconName }[] = [
  { page: 'chat', label: '聊一会儿', icon: 'message-circle' },
  { page: 'library', label: '我的对话', icon: 'book-open' },
  { page: 'settings', label: '连接与设置', icon: 'sliders' },
];

function Icon({ name, size = 20, color = colors.green }: { name: IconName; size?: number; color?: string }) {
  return <Feather name={name} size={size} color={color} />;
}
function Button({ text, icon, onPress, secondary, disabled, danger }: { text: string; icon?: IconName; onPress: () => void; secondary?: boolean; disabled?: boolean; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={text} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.button, secondary && s.buttonSecondary, danger && s.buttonDanger, (pressed || disabled) && { opacity: disabled ? 0.45 : 0.8 }]}>
    {icon && <Icon name={icon} size={17} color={secondary ? colors.green : '#fff'} />}
    <Text style={[s.buttonText, secondary && { color: colors.green }]}>{text}</Text>
  </Pressable>;
}
function SmallButton({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[s.iconButton, disabled && { opacity: 0.35 }]}><Icon name={icon} size={18} /></Pressable>;
}
function FreeLabel() { return <View style={s.freeBadge}><View style={s.dot} /><Text style={s.freeText}>免费 · 自愿打赏</Text></View>; }

function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MainScreen({ page = 'chat' }: { page?: Page }) {
  const app = useChatApp();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const draft = app.draftText;
  const setDraft = app.setDraftText;
  const [query, setQuery] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [rename, setRename] = useState<Conversation | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: () => void | Promise<void>; destructive?: boolean } | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [followRequest, setFollowRequest] = useState(0);
  const actions = useRef(app);
  useLayoutEffect(() => { actions.current = app; });
  const messages = app.active?.messages ?? emptyMessages;
  const contextMode = app.state.settings.contextMode ?? 'auto';
  const hasDraftAttachments = app.draftAttachments.length > 0;
  const attachmentModelMismatch = hasDraftAttachments && app.state.settings.model !== 'deepseek-flash';
  const sending = app.busy || app.attachmentsBusy;
  const sendDisabled = (!draft.trim() && !hasDraftAttachments) || app.working || attachmentModelMismatch;
  // Typing a draft must not sort/search every imported conversation. On phones,
  // the chat screen does not need a conversation index at all.
  const conversations = useMemo(() => page === 'library' || wide
    ? [...app.state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
    : app.state.conversations, [app.state.conversations, page, wide]);
  const searchQuery = useDeferredValue(query.trim().toLowerCase());
  const filtered = useMemo(() => {
    if (page !== 'library') return [];
    if (!searchQuery) return conversations;
    return conversations.filter(c => c.title.toLowerCase().includes(searchQuery)
      || c.messages.some(m => m.content.toLowerCase().includes(searchQuery)));
  }, [conversations, page, searchQuery]);

  const openConversation = useCallback((conversation: Conversation) => {
    actions.current.selectConversation(conversation.id);
    router.replace('/');
  }, []);
  const beginRename = useCallback((conversation: Conversation) => {
    setRename(conversation); setNewTitle(conversation.title);
  }, []);
  const beginRemove = useCallback((conversation: Conversation) => {
    setConfirm({ title: '删除这段对话？', description: '仅从本机对话列表删除。此操作无法撤销。', destructive: true,
      action: () => actions.current.removeConversation(conversation.id) });
  }, []);
  const onCopyMessage = useCallback((content: string) => {
    void Clipboard.setStringAsync(content).then(() => actions.current.setNotice('已复制到剪贴板。'))
      .catch(() => actions.current.setNotice('复制未完成，请重试。'));
  }, []);
  const onMessageLink = useCallback((url: string) => {
    setConfirm({ title: '打开外部网页？', description: url, action: async () => {
      if (!/^https:\/\//i.test(url)) return;
      try { await Linking.openURL(url); } catch { actions.current.setNotice('暂时无法打开链接，请稍后再试。'); }
    } });
  }, []);
  const onRetryMessage = useCallback((content: string) => {
    setFollowRequest(value => value + 1);
    void actions.current.send(content, true);
  }, []);
  const renderConversation = useCallback(({ item }: { item: Conversation }) => (
    <ConversationRow conversation={item} busy={app.busy} onOpen={openConversation} onRename={beginRename} onRemove={beginRemove} />
  ), [app.busy, openConversation, beginRename, beginRemove]);

  function go(destination: Page) { router.replace(routes[destination]); }
  function start() { app.newConversation(); go('chat'); }
  function send() {
    if (!app.apiKey) { app.setNotice('先连接自己的 DeepSeek 账户，就可以继续聊。'); go('settings'); return; }
    if (sending || sendDisabled) return;
    const value = draft;
    setFollowRequest(value => value + 1);
    // The provider owns per-conversation drafts across route changes and only
    // clears a question after committing it to history, never on upload failure.
    void app.send(value).catch(() => app.setNotice('发送未完成，问题与附件仍保留，请重试。'));
  }
  function pickAttachment(kind: 'image' | 'file') {
    if (!app.apiKey) { app.setNotice('先连接自己的 DeepSeek 账户，再添加图片或文件。'); go('settings'); return; }
    if (sending || app.working) return;
    void app.pickAttachments(kind);
  }
  function backup() {
    setConfirm({ title: '导出聊天备份', description: '导出文件包含明文聊天和导入原始记录，不会加入设置中保存的 API Key。请保存到可信的位置，不要公开分享。', action: app.backup });
  }
  function clearAll() {
    setConfirm({ title: '清除所有本机数据？', description: '所有对话、设置和 API Key 都将从本机删除，无法撤销。请先导出备份。这不会删除 DeepSeek 平台的数据或撤销官方 Key。', destructive: true, action: app.clearAll });
  }
  async function openLink(url: string) {
    if (!/^https:\/\//i.test(url)) return;
    try { await Linking.openURL(url); } catch { app.setNotice('暂时无法打开链接，请稍后再试。'); }
  }

  if (!app.ready) return <SafeAreaView style={[s.safe, s.center]}>
    <View style={[s.card, { maxWidth: 460, margin: 24 }]}>
      {app.loadError ? <><Text style={s.sectionTitle}>先保护好你的记录</Text><Text style={s.body}>{app.loadError}</Text><Button text="重试读取" onPress={() => void app.initialize()} /><Button secondary text="清除本机数据" onPress={clearAll} /></> : <><ActivityIndicator color={colors.green} /><Text style={s.body}>打开你的对话…</Text></>}
    </View>
    <Confirmation value={confirm} onClose={() => setConfirm(null)} />
  </SafeAreaView>;

  return <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
    <View style={s.appRow}>
      {wide && <View style={s.sidebar}>
        <View style={s.brand}><View style={s.brandMark}><Icon name="message-circle" color="#fff" size={25} /></View><View><Text style={s.brandName}>拾语</Text><Text style={s.brandSub}>把故事，接着聊。</Text></View></View>
        <Button text="开启一段新对话" icon="plus" onPress={start} disabled={app.busy} />
        <View style={s.navList}>{nav.map(item => <Pressable key={item.page} onPress={() => go(item.page)} accessibilityRole="button" accessibilityLabel={item.label} style={[s.navItem, page === item.page && s.navActive]}><Icon name={item.icon} /><Text style={[s.navLabel, page === item.page && { fontWeight: '700' }]}>{item.label}</Text>{page === item.page && <View style={s.dot} />}</Pressable>)}</View>
        <Text style={s.overline}>最近聊过</Text>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>{conversations.slice(0, 20).map(c => <Pressable key={c.id} onPress={() => openConversation(c)} style={[s.recent, c.id === app.active?.id && page === 'chat' && { backgroundColor: colors.pale }]}><Icon name="message-square" size={15} color={colors.muted} /><Text numberOfLines={1} style={s.recentText}>{c.title}</Text></Pressable>)}{!conversations.length && <Text style={s.muted}>新的故事，会留在这里。</Text>}</ScrollView>
        <Pressable accessibilityRole="button" onPress={() => go('support')} style={s.supportLink}><Text style={{ fontSize: 23 }}>🍗</Text><View><Text style={s.navLabel}>请作者吃个鸡腿</Text><Text style={s.tiny}>随心支持，不影响任何功能</Text></View><Icon name="chevron-right" size={16} /></Pressable>
        <FreeLabel />
      </View>}
      <View style={s.main}>
        <View style={[s.header, !wide && { paddingHorizontal: 18 }]}>
          <View style={{ flex: 1 }}><Text style={s.headerTitle}>{page === 'chat' ? app.active?.title ?? '聊一会儿' : page === 'library' ? '我的对话' : page === 'settings' ? '连接与设置' : '一点小小的支持'}</Text><Text style={s.tiny}>{page === 'chat' ? '你的故事，留在你的手机里' : '拾语 · 免费的私人聊天客户端'}</Text></View>
          {wide ? <View style={s.connectionBadge}><View style={[s.dot, { backgroundColor: app.apiKey ? '#67967A' : '#B7BDB7' }]} /><Text style={s.tiny}>{app.apiKey ? '已连接 DeepSeek' : '等待连接'}</Text></View> : <SmallButton icon="plus" label="新对话" onPress={start} disabled={app.busy} />}
        </View>
        {Platform.OS === 'web' && <View style={s.previewBanner}><Text style={s.tiny}>浏览器预览：数据和密钥仅临时保存在内存，刷新即清空。正式安卓版在本机安全保存。</Text></View>}
        {!!app.notice && <View style={s.notice}><Text style={[s.small, { flex: 1 }]}>{app.notice}</Text><SmallButton icon="x" label="关闭提示" onPress={() => app.setNotice('')} /></View>}
        {!!app.saveError && <Pressable onPress={app.retrySave} style={s.errorBanner}><Text style={s.errorText}>{app.saveError} 点击重试</Text></Pressable>}

        {page === 'chat' && <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {messages.length ? <ChatMessages key={app.active?.id} messages={messages} busy={app.busy} wide={wide}
            followRequest={followRequest} onCopy={onCopyMessage} onLink={onMessageLink} onRetry={onRetryMessage}
          /> : <ScrollView contentContainerStyle={s.welcomeScroll}>
            <View style={s.welcome}>
              <View style={s.welcomeIcon}><Icon name="feather" size={34} /></View>
              <Text style={s.welcomeKicker}>留一个位置，给想说的话</Text>
              <Text style={[s.hero, !wide && { fontSize: 32 }]}>把故事，接着聊。</Text>
              <Text style={s.welcomeBody}>今天的小事，没说完的心情。{ '\n' }在这里，慢慢说也没关系。</Text>
              <View style={s.welcomeCards}>
                <Pressable onPress={() => void app.pickHistory()} disabled={app.working || app.busy} style={s.welcomeCard}><View style={s.cardIcon}><Icon name="archive" size={21} /></View><Text style={s.cardTitle}>带上旧对话</Text><Text style={s.small}>导入 DeepSeek 记录{ '\n' }让过去的故事接着说</Text><Text style={s.cardArrow}>导入记录  ↗</Text></Pressable>
                <Pressable onPress={() => app.apiKey ? setDraft('今天有件小事，我想和你聊聊。') : go('settings')} style={s.welcomeCard}><View style={[s.cardIcon, { backgroundColor: colors.warm }]}><Icon name={app.apiKey ? 'sun' : 'key'} size={21} /></View><Text style={s.cardTitle}>{app.apiKey ? '从今天开始' : '连接你的账户'}</Text><Text style={s.small}>{app.apiKey ? '不用想好怎么开头\n一句话就可以' : '用自己的 API Key\n费用直接付给 DeepSeek'}</Text><Text style={s.cardArrow}>{app.apiKey ? '写下第一句话' : '简单设置'}  ↗</Text></Pressable>
              </View>
              <View style={s.privacyNote}><Icon name="lock" size={13} color={colors.muted} /><Text style={s.tiny}>本机保存 · 无广告 · 软件免费</Text></View>
            </View>
          </ScrollView>}
          <View style={[s.composerArea, { paddingHorizontal: wide ? 36 : 14 }]}>
            <View style={s.composer}>
              {hasDraftAttachments && <View style={s.attachmentsArea}>
                <ScrollView style={s.draftAttachments} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                  {app.draftAttachments.map(attachment => <View key={attachment.id} testID={`draft-attachment-${attachment.id}`} style={[s.draftAttachment, attachment.status === 'error' && s.attachmentErrorBorder]}>
                    {attachment.kind === 'image' && attachment.uri && /^(?:file:|content:|blob:)/i.test(attachment.uri)
                      ? <Image source={{ uri: attachment.uri }} style={s.attachmentThumbnail} resizeMode="cover" resizeMethod="resize" accessibilityLabel={`${attachment.name} 本地预览`} />
                      : <View style={s.attachmentIcon}><Icon name={attachment.kind === 'image' ? 'image' : 'file-text'} size={20} /></View>}
                    <View style={s.attachmentDescription}>
                      <Text style={s.attachmentName} numberOfLines={1}>{attachment.name}</Text>
                      <View style={s.attachmentStatusRow}>
                        {attachment.status === 'uploading' && <ActivityIndicator size="small" color={colors.green} />}
                        <Text style={s.tiny}>{formatAttachmentSize(attachment.bytes)} · {attachment.status === 'uploading' ? '上传或解析中…' : attachment.status === 'uploaded' ? '已上传，可直接重试发送' : attachment.status === 'error' ? '上传失败' : '待发送'}</Text>
                      </View>
                      {attachment.status === 'error' && <Text style={s.attachmentError}>{attachment.error || '上传未完成。再次点击发送可重试，或移除此附件。'}</Text>}
                    </View>
                    <SmallButton icon="x" label={`移除附件 ${attachment.name}`} onPress={() => app.removeDraftAttachment(attachment.id)} disabled={sending} />
                  </View>)}
                </ScrollView>
                <Text style={s.tiny}>发送时上传至 DeepSeek，文档解析和聊天按官方计费。文件保存在你的 DeepSeek 账户，聊天备份仅保留文件引用。</Text>
                {app.draftAttachments.some(attachment => attachment.status === 'error') && <Text style={s.attachmentError}>问题和附件已保留。可再次点击发送重试，已上传的附件会复用。</Text>}
              </View>}
              {attachmentModelMismatch && <View style={s.attachmentModelNotice}>
                <Text style={[s.small, { flex: 1 }]}>图片和文件需要 Flash。切换模型后即可发送，附件会保留。</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="切换到 Flash" disabled={sending} onPress={() => app.changeSettings({ model: 'deepseek-flash' })} style={s.switchModelButton}><Text style={s.switchModelText}>切换到 Flash</Text></Pressable>
              </View>}
              <TextInput value={draft} onChangeText={setDraft} multiline maxLength={40000} placeholder={hasDraftAttachments ? '想问附件里的什么？也可以直接发送。' : '有什么想说的，都可以从这里开始…'} placeholderTextColor="#8E9991" style={s.composerInput} accessibilityLabel="输入消息" editable={!sending} />
              <View style={s.composerBottom}>
                <SmallButton icon="image" label="添加图片" onPress={() => pickAttachment('image')} disabled={sending || app.working} />
                <SmallButton icon="paperclip" label="添加文件" onPress={() => pickAttachment('file')} disabled={sending || app.working} />
                <Pressable accessibilityRole="switch" accessibilityState={{ checked: app.state.settings.thinking }} onPress={() => app.changeSettings({ thinking: !app.state.settings.thinking })} disabled={sending} style={[s.thinkChip, app.state.settings.thinking && s.thinkActive]}><Icon name="aperture" size={15} /><Text style={s.chipText}>{app.state.settings.thinking ? '思考已开启' : '深度思考'}</Text></Pressable>
                <View style={{ flex: 1 }} />
                {sending ? <Pressable accessibilityRole="button" accessibilityLabel={app.attachmentsBusy ? '停止上传' : '停止生成'} onPress={app.stop} style={s.sendButton}><Icon name="square" color="#fff" size={18} /></Pressable> : <Pressable accessibilityRole="button" accessibilityLabel="发送消息" disabled={sendDisabled} onPress={send} style={[s.sendButton, sendDisabled && { backgroundColor: '#B7C8BC' }]}><Icon name="arrow-up" color="#fff" size={21} /></Pressable>}
              </View>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="查看上下文设置" onPress={() => go('settings')} style={s.contextSettingLink}><Text style={s.tiny}>{contextMode === 'auto' ? '上下文：自动尽量携带当前对话' : `上下文：限制最近 ${app.state.settings.contextMessageLimit} 条消息`} · 查看设置</Text></Pressable>
            <Text style={s.composerFootnote}>软件免费，API 按用量付费 · 回复由 AI 生成，请自行判断</Text>
          </View>
        </KeyboardAvoidingView>}

        {page === 'library' && <FlatList<Conversation> testID="conversation-list" data={filtered} keyExtractor={conversation => conversation.id}
          renderItem={renderConversation} extraData={app.busy} style={{ flex: 1 }} contentContainerStyle={s.libraryContent}
          initialNumToRender={10} maxToRenderPerBatch={8} windowSize={7} updateCellsBatchingPeriod={50} keyboardShouldPersistTaps="handled"
          ListHeaderComponent={<View style={s.libraryHeader}>
            <View style={s.pageLead}><Text style={s.pageTitle}>每一段，都好好留着。</Text><Text style={s.body}>记录保存在本机。导入会合并已有对话，不会覆盖。</Text></View>
            <View style={s.rowWrap}><Button text={app.working ? '正在读取…' : '导入旧对话'} icon="download" onPress={() => void app.pickHistory()} disabled={app.working || app.busy} /><Button text="导出备份" icon="upload" secondary onPress={backup} disabled={app.working || app.busy || !conversations.length} /></View>
            <View style={s.search}><Icon name="search" color={colors.muted} size={18} /><TextInput value={query} onChangeText={setQuery} placeholder="搜索标题或聊天内容" accessibilityLabel="搜索对话" style={s.searchInput} /></View>
            <Text style={s.overline}>{filtered.length} 段对话</Text>
          </View>}
          ListEmptyComponent={<View style={s.empty}><Icon name="book-open" size={32} color="#8CA092" /><Text style={s.body}>{query ? '还没有找到这段对话。' : '这里等着收藏你的第一段对话。'}</Text></View>}
          ListFooterComponent={<View style={s.infoCard}><Icon name="info" size={18} /><Text style={[s.small, { flex: 1 }]}>支持 DeepSeek ZIP 与 JSON，以及拾语备份。导入的文字可用于续聊；官方旧附件和联网工具上下文不会自动恢复，需要重新添加附件。换机或卸载前，请先导出备份。</Text></View>}
        />}

        {page === 'settings' && <ScrollView contentContainerStyle={s.pageContent} keyboardShouldPersistTaps="handled">
          <View style={s.pageLead}><Text style={s.pageTitle}>简单设置，安心开始。</Text><Text style={s.body}>使用你自己的 DeepSeek 账户。我们不代收 API 费用。</Text></View>
          <View style={s.card}><View style={s.cardHeading}><View style={s.cardIcon}><Icon name="key" /></View><View style={{ flex: 1 }}><Text style={s.sectionTitle}>连接 DeepSeek</Text><Text style={s.small}>{app.apiKey ? '已保存密钥，不会在这里显示完整内容' : '只需设置一次，之后直接打开就能聊'}</Text></View></View>
            <View style={s.steps}><Text style={s.small}>① 在官方开放平台登录、充值并创建 API Key</Text><Text style={s.small}>② 复制 Key，在下方粘贴并验证连接</Text><Text style={s.small}>③ 返回聊天，或先带上你的旧对话</Text></View>
            {Platform.OS !== 'ios' && <Pressable accessibilityRole="link" onPress={() => void openLink('https://platform.deepseek.com/')} style={s.textLink}><Text style={s.linkText}>打开 DeepSeek 官方开放平台</Text><Icon name="external-link" size={15} /></Pressable>}
            <View style={s.keyField}><TextInput value={keyInput} onChangeText={setKeyInput} secureTextEntry={!showKey} autoCorrect={false} autoCapitalize="none" placeholder={app.apiKey ? '粘贴新的 Key 可更换账户' : '粘贴你的 API Key'} style={s.keyInput} accessibilityLabel="API Key" /><SmallButton icon={showKey ? 'eye-off' : 'eye'} label={showKey ? '隐藏密钥' : '显示密钥'} onPress={() => setShowKey(!showKey)} /></View>
            <Button text={app.working ? '正在连接…' : '验证并安全保存'} onPress={() => { void app.connect(keyInput).then(success => { if (success) setKeyInput(''); }); }} disabled={!keyInput.trim() || app.working || app.busy} />
            <Text style={s.tiny}>密钥只用于连接官方 API，不会上传给作者。连接验证会查询账户余额，不生成聊天。</Text>
            {!!app.apiKey && <View style={s.balanceRow}><View><Text style={s.tiny}>DeepSeek 账户余额</Text><Text style={s.balance}>{app.balance ? `${app.balance.currency === 'CNY' ? '¥' : '$'} ${app.balance.total}` : '点击刷新查询'}</Text></View><SmallButton icon="refresh-cw" label="刷新余额" onPress={() => void app.refreshBalance()} disabled={app.working} /><Pressable onPress={() => setConfirm({ title: '移除本机密钥？', description: '聊天记录会保留，下次聊天需重新连接账户。', action: app.forgetKey })} disabled={app.busy || app.working}><Text style={s.small}>移除密钥</Text></Pressable></View>}
          </View>
          <View style={s.card}><Text style={s.sectionTitle}>聊天偏好</Text>
            <View style={s.settingRow}><View style={{ flex: 1 }}><Text style={s.cardTitle}>深度思考</Text><Text style={s.small}>适合复杂问题，等待时间与消耗可能增加</Text></View><Switch value={app.state.settings.thinking} disabled={app.busy} onValueChange={thinking => app.changeSettings({ thinking })} trackColor={{ true: colors.green, false: '#D6DED6' }} /></View>
            <Text style={s.cardTitle}>使用模型</Text><View style={s.rowWrap}>{(['deepseek-flash', 'deepseek-v4-pro'] as const).map(model => <Pressable key={model} accessibilityRole="button" accessibilityLabel={model === 'deepseek-flash' ? '使用 Flash 模型' : '使用 Pro 模型'} disabled={sending} onPress={() => app.changeSettings({ model })} style={[s.choice, app.state.settings.model === model && s.choiceSelected]}><Text style={s.chipText}>{model === 'deepseek-flash' ? 'Flash · 支持图片和文件' : 'Pro · 文字复杂任务'}</Text></Pressable>)}</View>
            <Text style={s.cardTitle}>续聊时携带的上下文</Text>
            <View style={s.rowWrap}>
              <Pressable accessibilityRole="button" accessibilityLabel="自动携带上下文" accessibilityState={{ selected: contextMode === 'auto' }} disabled={sending} onPress={() => app.changeSettings({ contextMode: 'auto' })} style={[s.choice, contextMode === 'auto' && s.choiceSelected]}><Text style={s.chipText}>自动（推荐）</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="限制最近消息" accessibilityState={{ selected: contextMode === 'recent' }} disabled={sending} onPress={() => app.changeSettings({ contextMode: 'recent' })} style={[s.choice, contextMode === 'recent' && s.choiceSelected]}><Text style={s.chipText}>限制最近消息</Text></Pressable>
            </View>
            {contextMode === 'recent' && <View style={s.rowWrap}>{[20, 40, 80].map(count => <Pressable key={count} accessibilityRole="button" accessibilityLabel={`最多携带 ${count} 条消息`} disabled={sending} onPress={() => app.changeSettings({ contextMessageLimit: count })} style={[s.choice, app.state.settings.contextMessageLimit === count && s.choiceSelected]}><Text style={s.chipText}>{count} 条</Text></Pressable>)}</View>}
            <Text style={s.small}>{contextMode === 'auto' ? '自动模式会尽量携带当前对话的完整有效历史；超过上下文容量时保留近期内容。对话越长，API 消耗和等待时间可能越多。' : '只携带所选范围内的最近完整对话，费用通常更可控；更早的内容不会发给模型。'} 每次回复下方会显示实际携带的历史数量。原记录仍完整保存在本机，这不等于模型有永久记忆。</Text>
          </View>
          <View style={s.card}><Text style={s.sectionTitle}>记录与隐私</Text><Button text="导出聊天备份" icon="upload" secondary onPress={backup} disabled={app.working || app.busy || !conversations.length} /><Button text="了解数据如何处理" icon="shield" secondary onPress={() => setPrivacy(true)} /><Button text="清除所有本机数据" secondary onPress={clearAll} disabled={app.busy || app.working} /></View>
          <View style={s.aboutCard}><FreeLabel /><Text style={s.sectionTitle}>拾语 · 一个安静的聊天角落</Text><Text style={s.body}>所有功能免费，没有广告，也没有会员。{ '\n' }API 费用由你直接支付给 DeepSeek。</Text><Pressable accessibilityRole="button" onPress={() => go('support')}><Text style={s.linkText}>🍗 请作者吃个鸡腿 →</Text></Pressable><Text style={s.tiny}>独立第三方客户端，与 DeepSeek 无官方隶属关系。</Text></View>
        </ScrollView>}

        {page === 'support' && <ScrollView contentContainerStyle={s.pageContent}><SupportPanel /></ScrollView>}
      </View>
    </View>
    {!wide && <View style={s.bottomNav}>{[...nav, { page: 'support' as Page, label: '支持作者', icon: 'heart' as IconName }].map(item => <Pressable key={item.page} accessibilityRole="tab" accessibilityState={{ selected: page === item.page }} accessibilityLabel={item.label} onPress={() => go(item.page)} style={s.bottomNavItem}><Icon name={item.icon} color={page === item.page ? colors.green : '#99A29B'} size={21} /><Text style={[s.bottomLabel, page === item.page && { color: colors.green, fontWeight: '700' }]}>{item.label}</Text></Pressable>)}</View>}

    <Confirmation value={confirm} onClose={() => setConfirm(null)} />
    <Modal visible={!!rename} transparent animationType="fade" onRequestClose={() => setRename(null)}><View style={s.overlay}><View style={s.dialog}><Text style={s.sectionTitle}>给这段对话起个名字</Text><TextInput style={s.dialogInput} value={newTitle} onChangeText={setNewTitle} maxLength={80} autoFocus accessibilityLabel="对话名称" /><View style={s.rowWrap}><Button secondary text="取消" onPress={() => setRename(null)} /><Button text="保存名称" disabled={!newTitle.trim()} onPress={() => { if (rename) app.renameConversation(rename.id, newTitle); setRename(null); }} /></View></View></View></Modal>
    <Modal visible={!!app.preview} transparent animationType="fade" onRequestClose={() => app.setPreview(null)}><View style={s.overlay}><View style={[s.dialog, { maxHeight: '85%' }]}><Text style={s.sectionTitle}>先看看，要带回哪些故事</Text><Text style={s.body}>识别到 {app.preview?.conversations.length} 段对话、{app.preview?.messageCount} 条消息。</Text><ScrollView style={{ maxHeight: 300 }}>{app.preview?.warnings.map((warning, index) => <Text key={index} style={s.warningText}>• {warning}</Text>)}{app.preview?.conversations.slice(0, 12).map(c => <Text key={c.id} style={[s.small, { marginVertical: 5 }]} numberOfLines={1}>▤  {c.title}</Text>)}</ScrollView><Text style={s.tiny}>合并导入，保留已有对话。重复来源会跳过，不自动覆盖。</Text><View style={s.rowWrap}><Button secondary text="先不导入" onPress={() => app.setPreview(null)} /><Button text="确认合并导入" icon="download" onPress={app.confirmImport} disabled={app.busy} /></View></View></View></Modal>
    <Modal visible={privacy} transparent animationType="fade" onRequestClose={() => setPrivacy(false)}><View style={s.overlay}><View style={s.dialog}><Text style={s.sectionTitle}>你的记录，你来掌握</Text><Text style={s.body}>• 安卓聊天记录在本机加密保存，密钥由系统安全存储保管。{ '\n\n' }• 发消息时，当前问题、选定范围的历史和附件会直接发送给 DeepSeek，用于生成回答。附件保存在你的 DeepSeek 账户，文档解析和聊天按官方计费。不会经过作者的聊天服务器。{ '\n\n' }• 不接入广告、追踪或云同步。导出备份是明文文件，包含聊天与导入原记录；新附件仅备份文件引用，不包含原件，请妥善保管。{ '\n\n' }• 可以移除 Key 或清除本机数据。撤销官方 Key、删除 DeepSeek 平台的数据需到官方平台操作。</Text><Button text="我知道了" onPress={() => setPrivacy(false)} /></View></View></Modal>
  </SafeAreaView>;
}

function lastUserPreview(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') return messages[index].content.slice(0, 160)
      || messages[index].attachments?.map(attachment => attachment.name).join('、').slice(0, 160) || '附件消息';
  }
  return '还没写下第一句话';
}

const ConversationRow = memo(function ConversationRow({ conversation, busy, onOpen, onRename, onRemove }: {
  conversation: Conversation; busy: boolean; onOpen: (conversation: Conversation) => void;
  onRename: (conversation: Conversation) => void; onRemove: (conversation: Conversation) => void;
}) {
  const preview = lastUserPreview(conversation.messages);
  return <View testID={`conversation-${conversation.id}`} style={s.conversationRow}>
    <Pressable accessibilityRole="button" accessibilityLabel={`打开对话 ${conversation.title}`} style={s.conversationSummary} onPress={() => onOpen(conversation)}>
      <Text style={s.cardTitle} numberOfLines={1}>{conversation.title}</Text><Text style={s.small} numberOfLines={1}>{preview}</Text>
      <Text style={s.tiny}>{new Date(conversation.updatedAt).toLocaleDateString('zh-CN')} · {conversation.messages.length} 条消息{conversation.sourceId ? ' · 导入的对话' : ''}</Text>
    </Pressable>
    <SmallButton icon="edit-2" label={`重命名 ${conversation.title}`} onPress={() => onRename(conversation)} disabled={busy} />
    <SmallButton icon="trash-2" label={`删除 ${conversation.title}`} onPress={() => onRemove(conversation)} disabled={busy} />
  </View>;
});

function Confirmation({ value, onClose }: { value: { title: string; description: string; action: () => void | Promise<void>; destructive?: boolean } | null; onClose: () => void }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  function close() { setError(''); onClose(); }
  return <Modal visible={!!value} transparent animationType="fade" onRequestClose={() => { if (!running) close(); }}><View style={s.overlay}><View style={s.dialog}><Text style={s.sectionTitle}>{value?.title}</Text><Text style={s.body}>{value?.description}</Text>{!!error && <Text style={s.errorText}>{error}</Text>}<View style={s.rowWrap}><Button text="取消" secondary disabled={running} onPress={close} /><Button text={running ? '处理中…' : value?.destructive ? '确认清除' : '继续'} danger={value?.destructive} disabled={running} onPress={() => {
    setRunning(true); setError('');
    Promise.resolve().then(() => value?.action()).then(onClose).catch(() => setError('操作未完成，请重试。')).finally(() => setRunning(false));
  }} /></View></View></View></Modal>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg }, center: { justifyContent: 'center', alignItems: 'center' }, appRow: { flex: 1, flexDirection: 'row' }, main: { flex: 1, minWidth: 0 },
  sidebar: { width: 270, backgroundColor: '#F1F3EC', borderRightWidth: 1, borderRightColor: colors.line, padding: 23, gap: 22 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, marginBottom: 10 }, brandMark: { width: 46, height: 46, borderRadius: 16, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }, brandName: { fontSize: 25, fontWeight: '700', color: colors.ink, letterSpacing: 3 }, brandSub: { fontSize: 11, color: colors.muted, marginTop: 3 },
  button: { backgroundColor: colors.green, minHeight: 46, paddingVertical: 12, paddingHorizontal: 18, borderRadius: 13, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 9 }, buttonSecondary: { backgroundColor: colors.pale, borderWidth: 1, borderColor: colors.line }, buttonDanger: { backgroundColor: '#A55344' }, buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' }, iconButton: { padding: 10, minWidth: 40, minHeight: 40, justifyContent: 'center', alignItems: 'center' },
  navList: { gap: 5 }, navItem: { flexDirection: 'row', alignItems: 'center', padding: 13, gap: 12, borderRadius: 12 }, navActive: { backgroundColor: '#E1E9DF' }, navLabel: { fontSize: 14, color: colors.ink, flex: 1 }, dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#6E977D' },
  overline: { fontSize: 11, letterSpacing: 2, color: colors.muted, fontWeight: '600' }, recent: { flexDirection: 'row', gap: 9, paddingVertical: 13, paddingHorizontal: 9, borderRadius: 8, alignItems: 'center' }, recentText: { fontSize: 13, color: '#657268', flex: 1 }, supportLink: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderColor: colors.line, paddingTop: 19 },
  freeBadge: { flexDirection: 'row', gap: 7, alignItems: 'center', alignSelf: 'flex-start', borderWidth: 1, borderColor: '#DDE5D8', backgroundColor: '#F1F5ED', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20 }, freeText: { color: '#617864', fontSize: 10, letterSpacing: 0.5 },
  header: { minHeight: 80, paddingHorizontal: 36, borderBottomWidth: 1, borderBottomColor: colors.line, flexDirection: 'row', alignItems: 'center', gap: 16 }, headerTitle: { color: colors.ink, fontSize: 17, fontWeight: '600', marginBottom: 5 }, connectionBadge: { flexDirection: 'row', gap: 7, alignItems: 'center' }, previewBanner: { paddingVertical: 8, paddingHorizontal: 20, backgroundColor: '#F3EFDE' }, notice: { margin: 12, marginBottom: 0, paddingLeft: 15, borderRadius: 12, backgroundColor: colors.pale, flexDirection: 'row', alignItems: 'center' }, errorBanner: { backgroundColor: '#F9EAE4', padding: 12 },
  welcomeScroll: { flexGrow: 1, justifyContent: 'center', padding: 22 }, welcome: { width: '100%', maxWidth: 580, alignSelf: 'center', alignItems: 'center', paddingVertical: 20 }, welcomeIcon: { height: 72, width: 72, borderRadius: 26, backgroundColor: '#E8EFE4', alignItems: 'center', justifyContent: 'center', marginBottom: 25, transform: [{ rotate: '-8deg' }] }, welcomeKicker: { color: '#87917F', fontSize: 12, letterSpacing: 3, marginBottom: 14 }, hero: { fontSize: 40, fontWeight: '600', color: colors.ink, letterSpacing: 1 }, welcomeBody: { fontSize: 14, color: colors.muted, lineHeight: 25, textAlign: 'center', marginTop: 17 }, welcomeCards: { flexDirection: 'row', gap: 14, marginTop: 36, width: '100%' }, welcomeCard: { flex: 1, backgroundColor: '#fff', borderColor: colors.line, borderWidth: 1, borderRadius: 19, padding: 19, gap: 12 }, cardIcon: { width: 40, height: 40, backgroundColor: colors.pale, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, cardTitle: { fontSize: 15, fontWeight: '600', color: colors.ink }, cardArrow: { fontSize: 12, color: colors.green, marginTop: 5 }, privacyNote: { flexDirection: 'row', gap: 7, marginTop: 25, alignItems: 'center' },
  composerArea: { paddingTop: 12, paddingBottom: 12, backgroundColor: colors.bg }, composer: { maxWidth: 820, width: '100%', alignSelf: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: '#DDE4DA', borderRadius: 21, padding: 15, boxShadow: '0 3px 16px rgba(38,65,45,0.03)' }, composerInput: { fontSize: 15, lineHeight: 24, color: colors.ink, minHeight: 47, maxHeight: 160, padding: 0, textAlignVertical: 'top' }, composerBottom: { flexDirection: 'row', alignItems: 'center', marginTop: 7 }, thinkChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9, borderWidth: 1, borderColor: colors.line }, thinkActive: { backgroundColor: '#E6EFE3', borderColor: '#B2C9AF' }, chipText: { color: colors.green, fontSize: 12 }, sendButton: { height: 37, width: 37, backgroundColor: colors.green, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, composerFootnote: { textAlign: 'center', fontSize: 10, lineHeight: 16, color: '#969C91', marginTop: 10 },
  attachmentsArea: { gap: 8, marginBottom: 10 }, draftAttachments: { maxHeight: 150 }, draftAttachment: { flexDirection: 'row', gap: 9, alignItems: 'center', backgroundColor: '#F6F8F2', borderWidth: 1, borderColor: colors.line, borderRadius: 11, padding: 8, marginBottom: 7 }, attachmentErrorBorder: { borderColor: '#D3A99A' }, attachmentIcon: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.pale, borderRadius: 8 }, attachmentThumbnail: { width: 38, height: 38, borderRadius: 8 }, attachmentDescription: { flex: 1, minWidth: 0, gap: 3 }, attachmentName: { fontSize: 12, fontWeight: '600', color: colors.ink }, attachmentStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 }, attachmentError: { fontSize: 11, lineHeight: 17, color: '#A45A44' }, attachmentModelNotice: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#F6F0E1', borderRadius: 10, padding: 10, marginBottom: 10 }, switchModelButton: { backgroundColor: colors.green, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 10 }, switchModelText: { color: '#fff', fontSize: 11, fontWeight: '600' }, contextSettingLink: { alignSelf: 'center', paddingTop: 7, paddingHorizontal: 8 },
  libraryContent: { padding: 24, paddingBottom: 50, width: '100%', maxWidth: 800, alignSelf: 'center' }, libraryHeader: { gap: 22, marginBottom: 22 }, conversationSummary: { flex: 1, gap: 7 },
  pageContent: { padding: 24, paddingBottom: 50, gap: 22, width: '100%', maxWidth: 800, alignSelf: 'center' }, pageLead: { marginTop: 15, marginBottom: 6, gap: 12 }, pageTitle: { fontSize: 26, lineHeight: 37, fontWeight: '600', color: colors.ink }, body: { fontSize: 14, lineHeight: 25, color: colors.muted }, small: { fontSize: 12, lineHeight: 21, color: colors.muted }, tiny: { fontSize: 10, lineHeight: 17, color: colors.muted }, muted: { fontSize: 12, lineHeight: 23, color: colors.muted }, rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, sectionTitle: { fontSize: 18, fontWeight: '600', color: colors.ink, lineHeight: 28 }, card: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line, padding: 23, borderRadius: 19, gap: 17 }, cardHeading: { flexDirection: 'row', gap: 12, alignItems: 'center' }, steps: { backgroundColor: colors.bg, borderRadius: 12, padding: 14, gap: 7 }, textLink: { flexDirection: 'row', gap: 8, alignItems: 'center' }, linkText: { color: colors.green, fontSize: 13, fontWeight: '600' }, keyField: { flexDirection: 'row', borderWidth: 1, borderColor: '#DDE4DA', borderRadius: 11, alignItems: 'center' }, keyInput: { flex: 1, padding: 13, fontSize: 14, color: colors.ink, minWidth: 0 }, balanceRow: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 17, flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'space-between' }, balance: { fontSize: 22, lineHeight: 34, color: colors.green, fontWeight: '600' }, settingRow: { flexDirection: 'row', gap: 12, alignItems: 'center' }, choice: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 }, choiceSelected: { backgroundColor: colors.pale, borderColor: '#9FB69E' }, aboutCard: { gap: 16, alignItems: 'flex-start', padding: 8 }, search: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: '#fff', paddingHorizontal: 14 }, searchInput: { flex: 1, paddingVertical: 14, color: colors.ink, fontSize: 14 }, conversationRow: { marginBottom: 16, flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line, borderRadius: 15, padding: 16 }, empty: { paddingVertical: 45, alignItems: 'center', gap: 18 }, infoCard: { flexDirection: 'row', gap: 12, padding: 16, backgroundColor: colors.pale, borderRadius: 13 },
  bottomNav: { flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: 1, borderColor: colors.line, paddingTop: 10, paddingBottom: 7 }, bottomNavItem: { flex: 1, alignItems: 'center', gap: 5, padding: 5 }, bottomLabel: { fontSize: 10, color: '#99A29B' }, overlay: { flex: 1, backgroundColor: 'rgba(23,39,30,0.35)', alignItems: 'center', justifyContent: 'center', padding: 24 }, dialog: { backgroundColor: colors.bg, borderRadius: 23, padding: 25, width: '100%', maxWidth: 500, gap: 19 }, dialogInput: { backgroundColor: '#fff', borderColor: colors.line, borderWidth: 1, padding: 13, borderRadius: 10, color: colors.ink }, errorText: { color: '#A45A44', fontSize: 13, lineHeight: 23 }, warningText: { color: '#8A7250', fontSize: 12, lineHeight: 23, marginBottom: 6 },
});
