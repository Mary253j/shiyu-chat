# 拾语发布指南

更新时间：2026-11-17。本文针对 `Mary253j/shiyu-chat` 的 **0.1.1 首次 GitHub 预发布**，同时发布 MIT 许可源码和签名 Android APK。目标渠道为 GitHub prerelease，不是应用商店；本文是发布步骤与核对说明，不表示发布已完成。

## 当前版本与范围

拾语是使用用户自己的 DeepSeek API Key 的免费聊天客户端。用户向 DeepSeek 充值，API 费用由用户承担；应用作者不出售 API 额度，也不提供共用 Key。

当前实现范围是文字聊天、思考模式和历史记录导入后的续聊。它尚未完成 DeepSeek 官方客户端的全部功能，不能宣传为官方客户端、完整替代版或保证回答完全一致的产品。历史记录导入不会自动同步官方账户，也不会转移模型内部状态。

本阶段仅开发和发布 Android，iOS 暂缓，不提供 iPhone 安装包或上架教程。技术方案为 Expo SDK 58、React Native 0.88、TypeScript 的原生 Android 应用。手机直接连接 `https://api.deepseek.com`，没有作者运营的聊天中转服务器、账户系统或云同步。Web 版本仅用于预览，数据保存在内存，刷新或关闭页面后丢失，不能代替原生版验证。

## 发布前先确定这些信息

1. 确认应用名称和图标，维护者为 GitHub 账号 [Mary253j](https://github.com/Mary253j)。普通反馈使用仓库 Issues，仅接收非敏感内容；安全报告计划启用 GitHub Private vulnerability reporting。不要使用未经许可的官方品牌或暗示官方隶属关系。
2. 核对最终 `android.package`。当前标识为 `com.shiyu.chat`；发布前确认使用权和唯一性，发布后保持一致。派生项目应采用自己的标识和签名。
3. 将发布版本设为 `0.1.1`，并递增 Android `versionCode`。正式产物使用本项目独立保管的发布签名，不能继续使用 0.1.0 的通用测试签名。后续更新沿用正确签名。
4. 核对 [隐私说明](./PRIVACY.zh-CN.md) 与实际构建一致，公开维护者账号及可用反馈渠道。当前不能用 GitHub 用户名替代应用商店可能要求的实名运营主体；若以后进商店，再填写真实主体和对应资料。
5. 首发采用 GitHub prerelease：展示版本、签名 APK、校验值、变化及未验证项目。国内 Android 商店不是本次发布目标，不能套用同一套打赏和审核安排。

原生工程由 Expo 配置生成。需要改变原生设置时，优先修改应用配置或 config plugin，不把手动修改生成目录作为长期配置方案。SDK 升级前阅读对应版本的文档。[Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/)

## 本地准备与检查

在项目根目录安装依赖并运行检查；使用仓库的锁文件保持依赖一致：

```sh
npm ci
npx tsc --noEmit
npx expo lint
npx expo-doctor
```

若检查失败，先修复再生成正式构建。模拟器和 Web 预览通过不能代替 Android 真机测试。开发工具中的运行按钮也不等于已经生成可公开分发的正式安装包。

至少在 Android 真机验证：

- 首次启动、用户知情后填写自己的 Key、有效和无效 Key、余额不足、网络中断、停止生成和请求失败后的再次发送。
- 文字与思考模式、长对话、导入真实脱敏样本、导入错误文件时不破坏已有记录、重启后历史恢复。
- 备份导出前显示明文提醒，导出过程不加入设置中保存的 API Key 或本地加密密钥；重新导入能恢复预期的聊天内容。
- 删除记录和清除 Key 后的实际状态，以及卸载、重装、系统备份恢复的行为。
- 对同签名版本验证覆盖升级；对 0.1.0 → 0.1.1 验证“先导出并确认备份，再卸载、安装、导入”的迁移路径，不能在未备份时直接要求卸载。
- 发布构建不记录 Key、完整提示词或聊天正文；错误提示也不暴露这些内容。

### 必须明确记录的未验证项

微信／支付宝收款码原图已取得并纳入版本；这不代表付款流程验证通过。目前仍未完成 Android 真机、真实 API Key、真实用户导出文件和实际微信／支付宝付款验证。发布时将各项结果分别写入 Release；如果仍未完成，应保持 prerelease 标记并如实说明，不以静态检查、模拟测试、构建或签名校验替代。

## 从 0.1.0 测试版迁移

0.1.0 使用通用测试签名，0.1.1 改用项目独立发布签名，Android 通常会拒绝直接覆盖安装。迁移说明必须随 APK 发布：

1. 在旧版导出聊天备份，保存到应用目录之外，并确认文件可读取。备份是明文，勿公开分享。
2. 确认备份可用后才卸载 0.1.0；卸载会移除原本地数据和密钥，未备份的数据无法由维护者找回。
3. 安装 0.1.1，导入备份并重新填写自己的 API Key。

独立发布签名不等于应用稳定性已完成验证。记录正式 APK 的签名证书 SHA-256 指纹，并持续安全保管该密钥。

## 首选：通过 Expo Build 云构建 Android APK

不需要自行购买或维护构建服务器。Expo Build 是托管编译服务，CLI 仍使用 `eas` 命令；它与运行时的聊天服务是两回事，用户聊天仍由手机直连 DeepSeek。

以下步骤会连接作者自己的 Expo 账户并上传构建所需的项目文件；当前没有代为执行。首次准备构建时先注册并登录账户：

```sh
npx eas-cli@latest login
npx eas-cli@latest build:configure
```

选择 Android，并确认关联的是自己的 Expo 项目。检查 `eas.json`：给直接分发的 APK 配置一个名为 `preview` 的构建 profile，其中 `android.buildType` 应为 `apk`。不要将正式给用户使用的 APK 配置成 `developmentClient: true`。最小配置形式如下；已有其他设置时只合并需要的部分：

```json
{
  "build": {
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      }
    }
  }
}
```

执行构建：

```sh
npx eas-cli@latest build --platform android --profile preview
```

使用为本项目创建的独立 Android 发布 keystore；如果已经在本地生成，向 EAS 导入同一套凭据，不能重新生成另一套签名。云服务可保管签名凭据，维护者仍应安全备份并了解其保管方式。后续版本沿用相同应用标识和正确签名。[Expo APK 构建配置](https://docs.expo.dev/build-reference/apk/)、[Expo 构建与签名](https://docs.expo.dev/deploy/build-project/)

构建完成后，从 Expo 提供的构建页面下载 APK，在真机验证它不依赖开发服务器即可运行。APK 是可直接安装的文件；默认生成的 AAB 面向支持它的商店，不能直接让用户点击安装。取得 APK 不等于已公开发布 GitHub 仓库，也不等于通过任何应用商店审核。

如果需要开发客户端，应另外使用包含开发客户端配置的 profile。当前 SDK 与所装 Expo Go 的兼容性需要单独核对，不能保证扫描二维码后 Expo Go 就能运行本项目。

构建上传前确保项目没有真实 Key、聊天备份、收款平台密码或无关私人文件。托管构建可能有配额与费用，以所选账户方案为准。

## 备用：Android 本地开发与签名构建

### 1. 准备构建环境

安装 Android Studio、所需 Android SDK 和与当前 Expo／React Native 版本兼容的 JDK。在 Android Studio 完成 SDK 下载和首次 Gradle 同步。Windows、macOS 或 Linux 都可以构建 Android 版本。

在项目根目录生成 Android 工程：

```sh
npx expo prebuild --platform android
```

用 Android Studio 打开生成的 `android` 目录，等待同步完成。如只需开发测试，可以连接开启 USB 调试的设备后运行：

```sh
npx expo run:android
```

开发测试构建不能直接当作正式发布版本。[Expo 本地发布构建](https://docs.expo.dev/guides/local-app-production/)

### 2. 生成正式签名安装包

在 Android Studio 选择 **Build → Generate Signed App Bundle or APK**：

1. GitHub 直接分发选 **APK**；需要 Android App Bundle 的商店选 **Android App Bundle**。AAB 不是用户直接点击安装的 APK。
2. 创建或选择自己的发布 keystore、密钥 alias 和密码。将 keystore 放在仓库之外，另做安全备份；不要使用项目的 debug 签名发布。
3. 选择 `release` 构建，生成签名产物，并通过完成提示定位输出文件。输出路径取决于构建设置，不依赖猜测的文件名。
4. 在真机安装该产物，确认不用开发服务器也能启动、连接 API、保存和恢复历史。
5. 用 Android SDK 的 `apksigner verify --print-certs` 检查最终 APK，记录签名证书指纹；为 APK 生成 SHA-256 文件校验值，便于用户核对。

签名密钥、密码、发布令牌和任何 API Key 都不能提交到仓库或放入 Release 附件。直接分发 APK 时，保管好应用签名密钥，否则可能无法向已安装用户提供正常更新。[Android 官方签名指南](https://developer.android.com/studio/publish/app-signing)

## 发布到 GitHub prerelease

目标仓库：[Mary253j/shiyu-chat](https://github.com/Mary253j/shiyu-chat)。按以下顺序完成并核验：

1. 检查代码、提交记录、截图、样例数据和构建附件，移除个人聊天、收款信息以外的私人资料及所有密钥。
2. 保留 MIT `LICENSE` 以及第三方依赖所需的版权和许可证信息，只将作者授权公开的微信／支付宝二维码原图纳入源码。
3. 创建或核对目标仓库，启用 Issues 和 **Private vulnerability reporting**。按实际结果更新文档，不能在通道未启用时宣称可用。
4. 将最终源码推送到仓库，为该提交建立 `v0.1.1` 标记。创建对应的 **prerelease**，附独立发布签名 APK、SHA-256 文件校验值和签名证书指纹，说明支持 Android 7.0 及以上 ARM64 手机。发布说明使用 [v0.1.1.md](./releases/v0.1.1.md)，例如通过 `gh release create` 的 `--notes-file` 参数读取；上传前补入实际验证结果。
5. 附上 0.1.0 签名迁移说明，明确软件免费、API 自付、打赏不解锁功能、非 DeepSeek 官方，并逐项列出未完成的真机／真实 API／收款验证。
6. 从发布页面重新下载 APK，核对大小、哈希、签名和版本；确认 README 链接、源码标签及 Release 附件对应同一版本。完成后才报告发布成功。

用户在 Android 下载 APK 后可能需要允许浏览器或文件管理器安装未知来源应用，应由用户了解来源后自行决定。Android 官方支持网站等直接分发方式；不同系统、地区和设备的安装验证可能继续变化。[Android 其他分发方式](https://developer.android.com/distribute/marketing-tools/alternative-distribution)

国内 Android 商店需要分别注册开发者、提交安装包和材料，并遵循各自的支付与审核要求。不要将 GitHub 直装版的收款码直接复制到所有商店版本。较新的原生鸿蒙设备也不能默认使用 Android APK，覆盖这类设备需要另行适配。[华为平台兼容说明](https://developer.huawei.com/consumer/cn/doc/service/faq-0000002105172802/)

## 自愿支持：“请作者吃个鸡腿🍗”

所有功能免费，打赏完全自愿，不影响模型能力、聊天次数、历史导入或后续使用。打赏不用于给用户的 DeepSeek 账户充值，不承诺永久云服务，也不是慈善募捐。

| 渠道 | 当前状态 | 后续可采用的方式 |
| --- | --- | --- |
| Android GitHub APK | 已包含作者授权公开的微信／支付宝原图，未进行实际付款测试 | “请作者吃个鸡腿🍗”页面可切换查看；只在用户主动打开时展示 |
| 国内 Android 商店 | 待选渠道后确认 | 根据该商店规则和收款平台要求另行配置 |
| Web 预览 | 仅用于查看界面 | 不把占位内容或预览状态作为已开通收款的证明 |

两张二维码使用作者提供并授权公开的原图，随源码和 APK 分发；不重绘或猜测二维码内容。每次重新构建仍应确认两张原图均被包含且完整显示；不把图片检查等同于实际付款测试。个人收款渠道的用途、主体资格和结算仍遵守微信／支付宝等对应平台规则。没有自动验单或数字权益，就不需要为了确认打赏额外搭建订单后台；应用不能在用户仅打开支付页面后宣称“支付成功”。

## 面向中国大陆公开发布前

免费、开源、用户自带 Key 和没有作者服务器，并不自动免除服务提供者责任。应结合真实主体、功能和分发渠道，向属地主管部门和目标商店核实：

- APP 备案及应用内、商店页面的信息展示。工信部要求境内从事互联网信息服务的 APP 主办者履行相应备案手续。[工信部通知](https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2023/art_920db564162e4312916a01bed6540ad8.html)
- 通过 API 调用已备案模型的应用所适用的登记、模型名称及备案号／上线编号展示要求；不能把模型厂商完成备案等同于本应用完成手续。[网信办公告](https://www.cac.gov.cn/2026-09/14/c_1791136833136332.htm)
- 内容安全、AI 标识、隐私告知与投诉处理。DeepSeek 的对外服务指南要求开启安全校验，并由应用提供者履行相应义务。[DeepSeek 构建 Chatbot 指南](https://api-docs.deepseek.com/zh-cn/guides/build_a_chatbot/)

这些事项需要按正式版本核实。本文和代码中的预留配置，不代表已经取得任何备案、资质、品牌许可或审核通过。
