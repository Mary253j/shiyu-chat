import type { ImageSourcePropType } from 'react-native';

export type SupportMethodId = 'wechat' | 'alipay';

export interface SupportMethod {
  id: SupportMethodId;
  label: string;
  image: ImageSourcePropType | null;
  /** Original dimensions keep the author's full payment image uncropped. */
  width: number;
  height: number;
  recipient: string;
}

/**
 * Optional support only. None of these settings may gate a software feature.
 * Keep the Android QR code disabled in store builds until the store permits it.
 * The author's supplied payment images are bundled unchanged as local assets.
 */
export const SUPPORT: {
  androidEnabled: boolean;
  paymentMethods: SupportMethod[];
} = {
  androidEnabled: true,
  paymentMethods: [
    {
      id: 'wechat', label: '微信',
      image: require('../../assets/support/wechat.png'),
      width: 1300, height: 1769, recipient: '收款人：Wenstel(**星)',
    },
    {
      id: 'alipay', label: '支付宝',
      image: require('../../assets/support/alipay.jpg'),
      width: 1260, height: 1890, recipient: '收款人：**星',
    },
  ],
};
