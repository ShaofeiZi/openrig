// 第 5 层——6 张目标卡片，全部采用数字布局（第 15 次迭代由创始人选定）。战术示意图式对齐：
// 2 行 × 3 列，所有位置对齐，不错位。每张卡片宽 28%、高 220px。只有项目卡片采用水洗墨迹
// 外观，其余卡片使用清晰文字。
//
// 列布局：第 1 列 left-[5%]，第 2 列 left-[36%]，第 3 列 left-[67%]
// 行布局：上排 top-[22%]，下排 top-[55%]
//
// librarySize 属性将资料库卡片正文接入实时产物数量。实验室默认值保留静态的“现场目录 0.3.1”文案。

import { Network, Folder, Sparkles, FileText, Search, Cog } from "lucide-react";
import { VellumDestinationCard } from "./VellumDestinationCard.js";
import {
  TreeGraphic,
  StratigraphicGraphic,
  PulseGraphic,
  SphereGraphic,
  MagnifierGraphic,
  GearGraphic,
} from "./graphics.js";

interface DestinationsLayerProps {
  librarySize?: number;
}

export function DestinationsLayer({ librarySize }: DestinationsLayerProps = {}) {
  const libraryBody =
    librarySize && librarySize > 0
      ? `规格 · 插件 · 技能 · 上下文包。现场目录 0.3.1 —— ${librarySize} 个活跃产物。`
      : "规格 · 插件 · 技能 · 上下文包。现场目录 0.3.1 —— 38 个活跃产物。";

  return (
    <div
      data-testid="destinations-layer"
      className="absolute inset-0 z-[18] pointer-events-none"
    >
      <VellumDestinationCard
        to="/topology"
        num="01"
        big="01"
        label="拓扑"
        icon={<Network className="h-4 w-4" />}
        body="主机 · 工作组 · Pod · 席位树 —— 实时边 + 运行时；可钻取任意工作组的 Pod 图。"
        positionClass="top-[22%] left-[5%]"
        graphic={<TreeGraphic />}
        layout="numeral"
        callouts={["主机", "工作组", "Pod", "席位"]}
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/project"
        num="02"
        big="02"
        label="项目"
        icon={<Folder className="h-4 w-4" />}
        body="工作区 · 任务 · 切片。按智能体在做什么浏览所有进行中的工作，而非按仓库。"
        positionClass="top-[22%] left-[36%]"
        graphic={<StratigraphicGraphic />}
        layout="numeral"
        callouts={["工作区", "任务", "切片", "工作项"]}
        washed
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/for-you"
        num="03"
        big="03"
        label="为你"
        icon={<Sparkles className="h-4 w-4" />}
        body="行动流 → 需要你处理的 · 已交付的 · 进行中的。为操作者排序。"
        positionClass="top-[22%] left-[67%]"
        graphic={<PulseGraphic />}
        layout="numeral"
        callouts={["需要你处理", "已交付", "进行中", "已阻塞"]}
        accent
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/specs"
        num="04"
        big="04"
        label="库"
        icon={<FileText className="h-4 w-4" />}
        body={libraryBody}
        positionClass="top-[55%] left-[5%]"
        graphic={<SphereGraphic />}
        layout="numeral"
        callouts={["规格", "插件", "技能", "上下文包"]}
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/search"
        num="05"
        big="05"
        label="搜索与审计"
        icon={<Search className="h-4 w-4" />}
        body="审计历史 · 完整产物浏览器。V1 占位；完整界面在 V2 交付。"
        positionClass="top-[55%] left-[36%]"
        graphic={<MagnifierGraphic />}
        layout="numeral"
        callouts={["审计", "历史", "查询", "筛选"]}
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/settings"
        num="06"
        big="06"
        label="设置"
        icon={<Cog className="h-4 w-4" />}
        body="配置 · 策略 · 日志 · 状态。操作者级控制；配置存储支持；可回退。"
        positionClass="top-[55%] left-[67%]"
        graphic={<GearGraphic />}
        layout="numeral"
        callouts={["配置", "策略", "日志", "状态"]}
        tint="stone"
        shadow="ambient"
      />
    </div>
  );
}
