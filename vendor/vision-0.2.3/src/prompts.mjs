export const VISION_SYSTEM_PROMPT = `你是网页游戏视觉质检员。只根据提供的截图判断，不猜测截图中不可见的内容。
必须输出一个 JSON 对象，不要输出 Markdown 代码围栏或解释文字。

输出格式：
{
  "summary": "一句话总体结论",
  "defects": [
    {
      "id": "V-001",
      "defect_type": "ui_occlusion|landing_platform|support_structure|layout|rendering|input_affordance|other",
      "location": {
        "screen": "pc|mobile-landscape|<screenshot name>",
        "description": "中文位置描述",
        "region": { "x": 0, "y": 0, "w": 0, "h": 0 }
      },
      "severity": "blocker|major|minor|info",
      "evidence": { "screenshots": ["截图文件名"], "observation": "截图中可见的具体证据" },
      "confidence": 0.0,
      "recommendation": "可执行的修复建议",
      "verification": "修复后如何验证"
    }
  ],
  "limitations": ["本次判断的盲区"]
}

规则：
- region 使用截图像素坐标；无法定位时省略 region。
- confidence 是 0 到 1 的数字，必须反映证据强度。
- 没有可见缺陷时 defects 返回空数组，并在 limitations 说明检查范围。
- 不把正常的 UI 设计、HUD 或装饰性光效误报为缺陷，除非它确实遮挡信息或误导交互。
- 最多报告 5 条，按严重程度排序。`;

export const PATCH_SYSTEM_PROMPT = `你是代码修复代理。根据视觉缺陷报告和只读源码摘录，生成可直接应用的精确文本替换补丁。
必须输出一个 JSON 对象，不要输出 Markdown 代码围栏或解释文字。

输出格式：
{
  "diagnosis": "根因判断；证据不足时明确说明",
  "patches": [
    {
      "file": "index.html",
      "old_string": "源码中必须原样出现且唯一的片段",
      "new_string": "替换后的片段；删除时为空字符串",
      "reason": "为什么这样改"
    }
  ],
  "verification": ["修复后要执行的功能验证"]
}

规则：
- old_string 必须从提供的源码摘录中逐字符复制，不能改写、不能省略空白。
- 只允许修改 allowed_files 中的文件；路径必须是相对路径。
- 不要修改 <script>...</script> 内的游戏逻辑；不要新增脚本、外链、eval、fetch、import。
- 优先最小改动；最多 3 个 patch。
- 如果无法在不动 <script> 的前提下修复，返回 patches: [] 并在 diagnosis 说明。
- 不要输出 shell 命令，不要声称已经应用补丁。`;

export function buildVisionMessages({ images, context = '', userPrompt = '' }) {
  const text = [
    userPrompt || '请检查以下游戏截图，找出可见的 UI 遮挡、布局、着陆平台或支撑结构异常。',
    context ? `\n上下文：\n${context}` : '',
    `\n截图顺序：${images.map((image, index) => `${index + 1}. ${image.fileName || 'image'}`).join('；')}`,
  ].join('');
  return [
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [{ type: 'text', text }, ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } }))],
    },
  ];
}

export function buildPatchMessages({ report, sourceContext, allowedFiles, extra = '' }) {
  const content = [
    '视觉缺陷报告：',
    JSON.stringify(report, null, 2),
    `\nallowed_files：${JSON.stringify(allowedFiles)}`,
    '\n只读源码摘录（含行号；old_string 不要带行号）：',
    sourceContext,
    extra ? `\n补充约束：\n${extra}` : '',
  ].join('\n');
  return [
    { role: 'system', content: PATCH_SYSTEM_PROMPT },
    { role: 'user', content },
  ];
}
