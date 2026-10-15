import type { Article, Stage } from "./domain";
const rows: [string, string, string[], string, Stage, string][] = [
  [
    "我如何用 AI 重构个人知识工作流",
    "从碎片收集、渐进式总结到稳定输出，一套可复用的创作系统。",
    ["人工智能", "效率工具"],
    "林",
    "writing",
    "选题与灵感",
  ],
  [
    "Obsidian 极简主题改造手记",
    "记录一次从视觉噪音到专注写作环境的整理过程。",
    ["Obsidian", "设计"],
    "周",
    "writing",
    "技术笔记",
  ],
  [
    "独立开发周记 #12：先发布，再完美",
    "本周完成付费墙与数据看板，也重新思考了产品节奏。",
    ["独立开发"],
    "林",
    "writing",
    "产品思考",
  ],
  [
    "写给创作者的 Prompt 设计指南",
    "把模糊需求转化为可验证的提示词结构，附 8 个真实模板。",
    ["人工智能", "教程"],
    "沈",
    "review",
    "技术笔记",
  ],
  [
    "数字花园不是第二大脑",
    "它更像一块持续生长的公共思考空间，而不是资料仓库。",
    ["知识管理"],
    "林",
    "review",
    "选题与灵感",
  ],
  [
    "设计功能之前，先设计反馈回路",
    "用三个产品案例解释为什么行为闭环比功能清单更重要。",
    ["产品设计"],
    "周",
    "review",
    "产品思考",
  ],
  [
    "停止无效复盘：让每周回顾真正改变下周",
    "一份可执行的 30 分钟周回顾流程。",
    ["效率工具"],
    "林",
    "published",
    "生活方式",
  ],
  [
    "小团队如何建立轻量内容系统",
    "不用复杂 CMS，也能让选题、协作与分发清晰运转。",
    ["内容运营"],
    "沈",
    "published",
    "产品思考",
  ],
  [
    "从 3000 条笔记中，我删掉了什么",
    "减少收藏焦虑，重新建立笔记的进入与退出机制。",
    ["知识管理"],
    "周",
    "published",
    "选题与灵感",
  ],
  [
    "2026 创作者 AI 工具栈",
    "写作、研究、视觉与自动化：我长期使用的 12 个工具。",
    ["人工智能"],
    "林",
    "planned",
    "技术笔记",
  ],
  [
    "一个低摩擦的阅读输入系统",
    "从稍后读到永久笔记，减少信息在工具之间的损耗。",
    ["阅读"],
    "周",
    "planned",
    "生活方式",
  ],
  [
    "公开构建，如何避免变成表演",
    "透明、节奏与边界：持续分享产品进展的实践原则。",
    ["独立开发"],
    "沈",
    "planned",
    "产品思考",
  ],
];
export function fixtureArticles(): Article[] {
  return rows.map(([title, summary, tags, owner, stage, folder], i) => {
    const id = "demo-" + String(i + 1).padStart(2, "0");
    const fm = {
      content_id: id,
      title,
      summary,
      tags,
      owner,
      stage,
      board_order: ((i % 3) + 1) * 1024,
      planned_at:
        stage === "planned"
          ? `2026-10-${String(13 + (i % 3)).padStart(2, "0")}T20:00`
          : "",
      cover: "示例封面.png",
    };
    return {
      id,
      path: `内容/${folder}/${title}.md`,
      title,
      summary,
      tags,
      owner,
      stage,
      order: fm.board_order,
      plannedAt: fm.planned_at,
      archivedAt: "",
      cover: fm.cover,
      modified: Date.now() - (i + 1) * 720000,
      wordCount: [
        2840, 1460, 980, 4120, 2360, 3080, 3650, 2710, 4430, 5200, 2950, 3340,
      ][i],
      frontmatter: fm,
      markdown: `---\ncontent_id: ${id}\ntitle: ${title}\nsummary: ${summary}\nowner: ${owner}\nstage: ${stage}\ncover: 示例封面.png\ntags: [${tags.join(", ")}]\n---\n\n# ${title}\n\n${summary}\n\n## 从内容出发\n\n每一篇文章都是一份 Markdown 文档。看板管理创作阶段，平台交付记录保存实际结果。\n\n![[示例封面.png]]\n\n- 收集有价值的线索\n- 组织结构与论据\n- 预览并交付到目标平台\n\n> 让工具服务于持续写作。\n\n| 阶段 | 目标 |\n| --- | --- |\n| 写作 | 形成完整初稿 |\n| 审核 | 校对表达与素材 |\n\n\`\`\`js\nconst message = 'Write, review, publish';\nconsole.log(message);\n\`\`\`\n`,
      links:
        i % 3 === 0
          ? ["数字花园不是第二大脑", "设计功能之前，先设计反馈回路"]
          : [],
    };
  });
}
