import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getAgentModel,
  getInvocation,
  getMessage,
  getOverview,
  getSession,
  getUsage,
  listBotAdmins,
  listInvocations,
  listMemories,
  listMemoryChats,
  listMessages,
  listStickerSets,
  listStickers,
  type ListFilters,
} from "./api.ts";

export const PAGE_SIZE = 25;

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: getSession,
  staleTime: 0,
});

export const overviewQuery = queryOptions({
  queryKey: ["overview"],
  queryFn: getOverview,
});

export function usageQuery(days: number) {
  return queryOptions({
    queryKey: ["usage", days],
    queryFn: () => getUsage(days),
  });
}

export const stickerSetsQuery = queryOptions({
  queryKey: ["sticker-sets"],
  queryFn: listStickerSets,
});

export function invocationsQuery(filters: ListFilters) {
  return infiniteQueryOptions({
    queryKey: ["invocations", filters],
    queryFn: ({ pageParam }) => listInvocations({ ...filters, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function messagesQuery(filters: ListFilters) {
  return infiniteQueryOptions({
    queryKey: ["messages", filters],
    queryFn: ({ pageParam }) => listMessages({ ...filters, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function stickersQuery(filters: ListFilters) {
  return infiniteQueryOptions({
    queryKey: ["stickers", filters],
    queryFn: ({ pageParam }) => listStickers({ ...filters, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function memoriesQuery(filters: ListFilters) {
  return infiniteQueryOptions({
    queryKey: ["memories", filters],
    queryFn: ({ pageParam }) => listMemories({ ...filters, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export const memoryChatsQuery = queryOptions({
  queryKey: ["memory-chats"],
  queryFn: listMemoryChats,
});

export const adminsQuery = queryOptions({
  queryKey: ["admins"],
  queryFn: listBotAdmins,
});

export const modelQuery = queryOptions({
  queryKey: ["model"],
  queryFn: getAgentModel,
});

export function invocationQuery(id: string) {
  return queryOptions({
    queryKey: ["invocation", id],
    queryFn: () => getInvocation(id),
  });
}

export function messageQuery(id: string) {
  return queryOptions({
    queryKey: ["message", id],
    queryFn: () => getMessage(id),
  });
}
