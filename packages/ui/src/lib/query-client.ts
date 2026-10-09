import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,    // 5 秒——本地后台服务延迟很低
      gcTime: 5 * 60_000,  // 5 分钟——未用缓存短暂保留
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
