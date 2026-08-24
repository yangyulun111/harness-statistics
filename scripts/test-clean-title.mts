import { cleanTitle } from "@hs/ledger-core";

const cases = [
  '我目前想要生成一份关于"\\wsl.localhost\\Ubuntu-22.04\\home\\yyl\\project\\mma\\MMAD_BIAS_Eval\\docs\\paper\\v2\\build\\word\\IPODT2026_profiles_en.pdf"这份论文的中文PPT，帮我制定一个详细的方案',
  "# Files mentioned by the user:\n\n## x.png: C:/Users/Administrator/AppData/Local/Temp/x.png\n\n## My request:\n你是一个Agent记忆管理专家，帮我根据图中内容分析下述内容是否正确：是，我上一版明显冗长了。这里继续补充更多细节",
  "识别模型",
  "帮我分析Utopia-V/codex-deepseek-subagent这个项目",
  "/home/yyl/project/x/figures/figure1.pptx，帮我分析上述pptx真的可以编辑吗？为什么？",
  "",
];
for (const c of cases) console.log(JSON.stringify(cleanTitle(c)));
