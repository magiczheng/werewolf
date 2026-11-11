# 月夜角色插画

8 张独立角色原画使用内置 image_gen 工具生成，完整提示词保存在 `prompts.json`。
统一风格：墨绿森林、旧金月光、油画 / 水粉笔触、古典织物与金属细节。

网页素材位于 `public/images/roles/`：每个角色提供 768 × 768 JPEG 和 192 × 192 `-thumb.jpg` 缩略图。
角色键：wolf、whiteWolfKing、villager、seer、witch、hunter、guard、idiot。
`public/roles.html` 为整套图鉴预览。页面通过 `roleArt.js` 统一加载资源。

身份牌仅在确认身份或按住查看时展示，普通座位仅在角色已公开时展示插画。
阶段插画只依赖全场公开的阶段名称，不读取当前玩家的私有角色。
