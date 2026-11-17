# 本地存储格式 v2（0.1.2）

公开接口保持 `loadState()`、`saveState(state)`、`loadApiKey()`、`saveApiKey(key)`、`deleteAllLocalData()`。`saveState` 接受不可变快照：调用后不得原地修改该 state、会话、消息或 originalData；后续修改应创建新对象。Web 预览只保留内存引用，刷新即清空。

## 文件与密钥

目录仍为应用私有文档目录下的 `shiyu-private-v1`，因此可直接读取 0.1.1 安装的数据。

| 文件 | 内容 |
| --- | --- |
| `state-<generation>.enc` | 0.1.1 的整库 JSON/hex 加密文件，只作为升级输入或短期恢复副本 |
| `index-<generation>.enc` | v2 加密清单：设置、当前会话 ID、有序会话引用和保留策略 |
| `record-<generation>-<n>.enc` | 单个会话本体，包含消息、标题、时间等，不包含 originalData |
| `original-<generation>-<n>.enc` | `{storageVersion:2,id,originalData}`，完整保存导入原始资料 |
| 同名 `.pending` | 尚未提交的临时文件，不能作为可读状态 |

生成号在当前时间与已知所有正式/临时文件生成号之间单调递增。文件名只由程序生成，不使用用户导入的会话 ID 作为路径。

AES 主密钥继续使用 SecureStore 中的 `shiyu.local-state.key.v1`，服务标识仍为 `shiyu.local.secrets`。API Key 的 SecureStore 项名也保持不变。应用内缓存导入后的原生 AES Key 对象，避免每次自动保存重新读取和转换密钥；清空本地数据时丢弃缓存。

v2 文件为 `IV(12字节) + ciphertext + GCM tag(16字节)` 二进制。Expo Crypto 58 的原生异步 AES-256-GCM 负责加解密。AAD 为 `shiyu-chat/local-state/v2:<context>`，其中 context 是：

- 清单：`index:<清单文件名>`。
- 会话：`record:<会话ID>:<正文文件名>`。
- 原始资料：`original:<会话ID>:<原始资料文件名>`。

解密后进一步核对清单生成号、唯一会话 ID、正文和原始资料内部 ID。交换其他会话密文或修改文件引用不能绕过校验。

## 清单

```ts
interface StateManifest {
  storageVersion: 2;
  schemaVersion: 1;
  generation: number;
  activeConversationId: string | null;
  settings: Settings;
  conversations: { id: string; recordFile: string; originalFile?: string }[];
  previousIndex: string | null;
  legacyFallback: string | null;
}
```

清单不保存聊天正文，也不保存 API Key。所有正文和原始资料都必须先写完，最后才提交清单。

## 保存与读取

1. 首次读取时列出私有目录。后续自动保存使用文件名缓存，不重复扫描原生目录。
2. 读取最高生成号的 v2 清单及其全部引用；若没有 v2 清单，再读取最高生成号的 v1 文件。最高代损坏、密钥不可用或任一当前引用缺失时直接报错，不自动回退旧数据或用空库覆盖。
3. 读取时将遗留 `streaming` 消息恢复为 `stopped`、`contextEligible=false`，并标记该会话正文需要重写；不重写未改变的原始资料。
4. 保存比较会话对象引用，仅校验、序列化和加密发生变化的会话。originalData 引用未变时复用其独立密文。切换会话或改变设置只写小清单。完全没有变化时不加密或写文件；如以前清理失败，只重试清理。
5. 每份变更文件先写 `.pending`，再移动到同目录唯一正式文件名。最后以相同方式提交新清单，此前的正文写入不会改变可读状态。清单提交之后才更新内存缓存和清理旧文件。
6. 任一保存异常都会使内存存储缓存失效，下次保存先重读磁盘。这样即使原生移动已经完成但返回异常，也不会继续使用旧缓存判断“无需写入”。

只读启动仍需解密并解析全部会话，单份极大的 originalData 仍有一次性 JSON 解析成本；各会话之间主动让出 JS 线程。此版本没有实现按需加载整个历史数据库。

## 0.1.1 无损升级

v1 的算法、主密钥、AAD `shiyu-chat/local-state/AES-256-GCM/v1`、12 字节 nonce 与 16 字节 tag 保持原样。旧 hex 密文以分块转换让出 JS 线程，再交给原生 AES 解密，不再执行 JS AES 算法。

`loadState` 只读取旧数据。第一次后续保存将全部会话及 originalData 写成 v2 文件，所有文件成功后才提交 v2 清单。在此之前不删除任何旧状态；中途失败后重新打开仍能读取原 v1 数据。

第一份 v2 清单通常保留最新一份 v1 文件作为 `legacyFallback`。下一次实际提交 v2 新代时不再保留 v1；没有变化的保存不会为了清理 v1 特意生成新代。旧版可读的 64 MiB 整库不会因小清单预算而被拒绝，单份 v2 记录上限留出封装余量。

## 恢复副本与删除

普通提交最多保留一份直接前代清单及它引用的文件，不递归保留历史链。若本次保存删除了会话，新清单把 `previousIndex` 和 `legacyFallback` 设为 null，以清除仍能还原被删会话的旧副本。清理失败会在下次读取或保存重试；保留策略已写进当前清单，因此重启不会遗忘删除意图。

全部清除在调用时同步建立 epoch 屏障：正在进行的保存不再提交，已排队的旧快照及清除期间的新快照不会写回。删除操作在同一串行队列执行，先删除整个私有存储目录，成功后才删除主密钥和 API Key。文件删除失败时保留密钥，以便剩余密文仍可恢复。

逻辑删除和旧文件清理不等于闪存的物理安全擦除。本实现也不宣称能保证设备突然断电时最后一次文件系统写入已经持久落盘；任何不完整的当前代会被校验拒绝，原文件不会自动覆写为空库。

## 验证

`tests/state-store.test.ts` 使用真实 AES-GCM 的内存 IO 适配器，验证旧版密文互通、增量写入、接近 20 MiB 的 originalData 复用、迁移失败、读取恢复及清除屏障。`tests/storage-review.test.ts` 独立注入断点和损坏，验证当前代 fail-closed、AAD 绑定和删除恢复。

这些测试不是 OPPO 真机测试；原生 File、SecureStore 和 Expo Crypto 集成仍须用实际 Android 构建验证。

参考：[Expo 58 Crypto](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/)、[Expo 58 FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/)。
