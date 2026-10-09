# testbed-stub（51-04 容器 stub payload）

这是内置于 openrig-testbed 镜像的最小零 token stub-runtime rig，使 L3 daemon-in-container 流程无需真实 LLM 即可通过 `zrig up` 启动一个已稳定的拓扑。唯一席位运行确定性的 51-01 stub harness。它不是产品 rig，只用于证明容器能够无头启动真实 daemon，并让真实拓扑稳定下来。
