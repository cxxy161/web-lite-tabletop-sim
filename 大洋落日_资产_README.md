# 大洋落日（Sunset on the Ocean）资产提取说明

- 压缩包：`~/Downloads/大洋落日_资产.zip`（254 MB，1038 个文件）
- 提取日期：2026-10-03
- 对应工坊模组：`大洋落日 Sunset on the Ocean`，Steam Workshop ID **3636541733**

## 一、包内结构

```
大洋落日/
├── Mods/Images/          1003 张卡面/地图贴图（jpg 983 + png 20），约 199 MB
├── Mods/PDF/             3 份 PDF 规则书，约 59 MB
├── Mods/Assetbundles/    2 个 .unity3d 模型包，约 8.7 MB
├── Mods/Models/          1 个 .obj 网格
├── Mods/Workshop/        3636541733.json / 3636541733.png（工坊模组定义与封面）
├── Saves/大洋落日/       9 组存档（TS_Save_*.json + .png），含子目录 珊瑚海短1、中途岛短1
├── Saves/TS_AutoSave*    3 组自动存档（SaveName 均为“大洋落日”）+ SaveFileInfos.json（存档中文名）
├── manifest.tsv          1034 行：URL → 本地文件 → 引用字段 / 引用次数 / 来源存档
└── missing.txt           25 个本地缺失的资源 URL 及其引用位置
```

## 二、资产原本散落在哪

TTS 在这台机器上有两份数据目录（内容互相重复，缓存文件按 URL 命名）：

1. Windows 侧：`/media/cxxy168/OS/Users/cxxy168/Documents/My Games/Tabletop Simulator/`
2. Linux 游戏目录：`/media/cxxy168/game/SteamLibrary/steamapps/common/Tabletop Simulator/Tabletop Simulator_Data/`

各自的 `Mods/` 下有 `Images`、`Images Raw`、`Models`、`PDF`、`Assetbundles`、`Workshop` 等缓存目录。

## 三、提取原理

1. **解析引用**：读取 13 个源 JSON
   - `Saves/大洋落日/**/TS_Save_*.json`（9 个）
   - `Saves/TS_AutoSave*.json`（3 个，SaveName=大洋落日）
   - `Mods/Workshop/3636541733.json`（工坊模组本体）

   递归遍历整个 JSON 树，收集所有以 `http` 开头的字符串，命中字段有
   `ImageURL`、`ImageSecondaryURL`、`PDFUrl`、`AssetbundleURL`、`MeshURL`、`DiffuseURL`、`ColliderURL`、`SkyURL`，
   共 **1034 个唯一 URL**。

2. **映射到本地缓存**：TTS 缓存文件名 = **URL 去掉所有非字母数字字符 + 原始扩展名**
   ```
   https://steamusercontent-a.akamaihd.net/ugc/10001971065515145914/5751310F.../
   → httpssteamusercontentaakamaihdnetugc100019710655151459145751310F...jpg
   ```
   按该规则对两个缓存根建索引（去掉扩展名的 stem 作为 key），精确匹配；
   同一 key 在两处都存在时**优先取 Windows 侧**副本。

3. **按需拷贝**：只取被引用到的文件，目录限定 `Images / PDF / Assetbundles / Models`，
   **排除 `Images Raw`、`Models Raw`**（.rawt/.rawm 原始数据，体积翻倍但离线加载不需要）。
   另附加工坊定义与全部存档。

4. **产出清单**：`manifest.tsv`（每个 URL 的落盘路径与引用统计）、`missing.txt`（25 个本地没有缓存的 URL）。

5. **打包**：Python `zipfile`（ZIP_DEFLATED，compresslevel=6），中文路径自动置 UTF-8 标志。

## 四、校验结果

- `ZipFile.testzip()` 通过，1038 条目无损坏
- `manifest.tsv` 中 1009 个 `ok` 行 → 压缩包内对应文件 **1009/1009 全部存在**
- 魔数检查全部通过：jpg 995、png 21、pdf 3、unity3d 2、obj 1、json 14
- 中文条目 UTF-8 标志（bit 11）全部置位
- 未修改任何原始文件

## 五、如何还原到另一台机器的 TTS

1. 解压得到 `大洋落日/`
2. 把 `Mods/` 下各子目录的内容合并进 TTS 数据目录的 `Mods/`
   - Windows：`Documents\My Games\Tabletop Simulator\Mods\`
   - Linux：`<TTS安装目录>\Tabletop Simulator_Data\Mods\`
3. 把 `Saves/` 下内容合并进 TTS 数据目录的 `Saves/`
4. 启动 TTS → Load → 选择 `大洋落日` 或其子目录存档

游戏加载 URL 资源时会优先命中本地同名缓存，因此离线也能正常显示。

## 六、缺失的 25 个资源

见包内 `missing.txt`（多为卡面图，本地从未缓存）。补齐方法：

```bash
# 以 missing.txt 第一列的 URL 为例（GET 方式，CDN 匿名可访问）
curl -L -o "<key>.jpg" "https://steamusercontent-a.akamaihd.net/ugc/.../XXXX/"
# 文件名 = URL 去掉非字母数字 + 由响应 Content-Type 决定的扩展名
# 放入 Mods/Images/ 后重新加载存档即可
```

> 注：URL 以 `/` 结尾、无扩展名，**必须用 GET**（HEAD 会返回 404）；扩展名按响应头 `image/jpeg` / `image/png` 决定。

## 七、重新提取

提取脚本：`/tmp/opencode/extract_dayang.py`（如已被清理，可按本文第三节重写）。

```bash
python3 /tmp/opencode/extract_dayang.py     # 解析 + 拷贝到 /tmp/opencode/dayangluori/大洋落日
# 再用 zipfile 打包到 ~/Downloads/大洋落日_资产.zip
```

修改脚本顶部的 `ROOTS` / `ASSET_DIRS` / 源文件列表即可调整提取范围（例如加入 `Images Raw`）。
