import React, { useState } from 'react';
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SUPPORT, type SupportMethodId } from '../config/support';

interface SupportPanelProps {
  onClose?: () => void;
}

export default function SupportPanel({ onClose }: SupportPanelProps) {
  const [selectedId, setSelectedId] = useState<SupportMethodId>('wechat');
  const [showOriginal, setShowOriginal] = useState(false);
  const availableMethods = SUPPORT.androidEnabled && (Platform.OS === 'android' || Platform.OS === 'web')
    ? SUPPORT.paymentMethods.filter(method => method.image !== null && method.width > 0 && method.height > 0)
    : [];
  const selected = availableMethods.find(method => method.id === selectedId) ?? availableMethods[0];

  function selectMethod(id: SupportMethodId) {
    setSelectedId(id);
    setShowOriginal(false);
  }

  return (
    <View style={styles.card}>
      <View style={styles.illustration}><Text style={styles.chicken}>🍗</Text></View>
      <Text accessibilityRole="header" style={styles.title}>请作者吃个鸡腿</Text>
      <Text style={styles.description}>如果拾语让聊天变得轻松了一点，{'\n'}也可以请作者加个餐。</Text>
      <View style={styles.freeBadge}><Text style={styles.freeText}>所有功能免费 · 打赏完全自愿</Text></View>
      <Text style={styles.details}>打赏只是支持开发维护，不会解锁功能，也不包含 DeepSeek API 费用。不打赏，也一样好好聊天。</Text>

      {selected ? (
        <View style={styles.paymentSection}>
          <View style={styles.methodSwitch}>
            {availableMethods.map(method => {
              const active = method.id === selected.id;
              return (
                <Pressable
                  key={method.id}
                  accessibilityRole="button"
                  accessibilityLabel={`选择${method.label}收款`}
                  accessibilityState={{ selected: active }}
                  onPress={() => selectMethod(method.id)}
                  style={({ pressed }) => [styles.methodButton, active && styles.methodActive, pressed && styles.pressed]}
                >
                  <Text style={[styles.methodText, active && styles.methodTextActive]}>{method.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.qrCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`查看${selected.label}收款码大图`}
              onPress={() => setShowOriginal(true)}
              style={styles.imageButton}
            >
              <View style={[styles.imageFrame, { aspectRatio: selected.width / selected.height }]}>
                <Image
                  key={selected.id}
                  source={selected.image!}
                  testID={`support-code-${selected.id}`}
                  style={styles.imageFill}
                  resizeMode="contain"
                  accessibilityLabel={`${selected.label}自愿打赏收款码`}
                />
              </View>
              <Text style={styles.viewOriginal}>轻点查看大图</Text>
            </Pressable>
            {selected.recipient ? <Text style={styles.recipient}>{selected.recipient}</Text> : null}
          </View>
          <View style={styles.instructions}>
            <Text style={styles.instructionTitle}>随心就好，先谢谢你啦</Text>
            <Text style={styles.qrHelp}>截图保存收款码，然后打开{selected.label}的“扫一扫”，从相册选择截图识别；也可以使用另一台设备扫码。</Text>
            <Text style={styles.qrHelp}>付款前请核对收款人和金额。打赏不会抵扣 DeepSeek API 费用，也不会改变任何软件功能。</Text>
          </View>
        </View>
      ) : <Text style={styles.notice}>打赏暂未开放，感谢你的心意。</Text>}

      {onClose ? (
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}><Text style={styles.closeText}>继续聊天</Text></Pressable>
      ) : null}

      {selected && showOriginal ? (
        <Modal
          visible
          animationType="fade"
          presentationStyle="fullScreen"
          onRequestClose={() => setShowOriginal(false)}
        >
          <SafeAreaView style={styles.originalScreen}>
            <View style={styles.originalHeader}>
              <Text accessibilityRole="header" style={styles.originalTitle}>{selected.label}收款码</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭收款码大图"
                onPress={() => setShowOriginal(false)}
                style={styles.originalClose}
              ><Text style={styles.closeText}>关闭</Text></Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.originalContent}>
              <View style={[styles.originalImageFrame, { aspectRatio: selected.width / selected.height }]}>
                <Image
                  source={selected.image!}
                  testID={`support-code-original-${selected.id}`}
                  style={styles.imageFill}
                  resizeMode="contain"
                  accessibilityLabel={`${selected.label}收款码原图`}
                />
              </View>
              <Text style={styles.originalHint}>自愿支持作者 · 所有功能免费{ '\n' }截图后，可在{selected.label}“扫一扫”的相册中识别。</Text>
            </ScrollView>
          </SafeAreaView>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFDF7', borderRadius: 28, padding: 22, borderWidth: 1, borderColor: '#E8E6DC', alignItems: 'center', gap: 16 },
  illustration: { width: 100, height: 100, backgroundColor: '#F4EDD9', borderRadius: 50, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  chicken: { fontSize: 49 },
  title: { fontSize: 23, fontWeight: '700', color: '#233D33' },
  description: { fontSize: 15, lineHeight: 25, color: '#738077', textAlign: 'center' },
  freeBadge: { borderRadius: 20, backgroundColor: '#EAF2E8', paddingVertical: 9, paddingHorizontal: 15 },
  freeText: { fontSize: 12, fontWeight: '600', color: '#41634B' },
  details: { fontSize: 13, color: '#758078', lineHeight: 23, textAlign: 'center', maxWidth: 420 },
  paymentSection: { width: '100%', maxWidth: 520, gap: 16 },
  methodSwitch: { flexDirection: 'row', gap: 8, padding: 5, borderRadius: 18, backgroundColor: '#ECEFE6' },
  methodButton: { flex: 1, paddingVertical: 13, paddingHorizontal: 10, borderRadius: 13, alignItems: 'center', minHeight: 46 },
  methodActive: { backgroundColor: '#365C4C' },
  methodText: { color: '#647368', fontSize: 15, fontWeight: '600' },
  methodTextActive: { color: '#FFFDF7' },
  pressed: { opacity: 0.7 },
  qrCard: { backgroundColor: '#FFFFFF', borderColor: '#E8E6DC', borderWidth: 1, borderRadius: 18, padding: 8, alignItems: 'center', gap: 10, width: '100%' },
  imageButton: { width: '100%', alignItems: 'center', gap: 10, paddingBottom: 6 },
  imageFrame: { width: '100%' },
  imageFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, width: '100%', height: '100%' },
  viewOriginal: { color: '#365C4C', fontSize: 13, fontWeight: '600' },
  recipient: { color: '#233D33', fontSize: 14, fontWeight: '600' },
  instructions: { backgroundColor: '#F2F4EC', padding: 16, gap: 9, borderRadius: 16 },
  instructionTitle: { color: '#3D5C46', fontSize: 14, fontWeight: '600' },
  qrHelp: { color: '#758078', fontSize: 13, lineHeight: 22 },
  notice: { fontSize: 13, color: '#758078', textAlign: 'center', lineHeight: 22 },
  close: { padding: 12 },
  closeText: { color: '#365C4C', fontSize: 14, fontWeight: '600' },
  originalScreen: { flex: 1, backgroundColor: '#FFFDF7' },
  originalHeader: { paddingHorizontal: 20, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#E8E6DC' },
  originalTitle: { color: '#233D33', fontSize: 18, fontWeight: '600' },
  originalClose: { paddingHorizontal: 16, paddingVertical: 12 },
  originalContent: { padding: 8, paddingBottom: 30, alignItems: 'center', gap: 18 },
  originalImageFrame: { width: '100%', maxWidth: 760 },
  originalHint: { color: '#758078', fontSize: 13, textAlign: 'center', lineHeight: 22 },
});
