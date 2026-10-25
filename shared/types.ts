/** 支持的网盘平台。老数据没有这个字段，读出来时按 quark 处理。 */
export type Platform = "quark" | "uc" | "baidu";

export const PLATFORM_NAMES: Record<Platform, string> = {
  quark: "夸克网盘",
  uc: "UC网盘",
  baidu: "百度网盘",
};

export type Account = {
  id: string;
  /** 归属用户。老数据没有这个字段，第一个注册的用户会继承 */
  userId?: string;
  platform: Platform;
  nickname: string;
  cookieHint: string;
  addedAt: string;
};

/** 对外暴露的用户信息，不含密码相关字段 */
export type PublicUser = {
  id: string;
  username: string;
  createdAt: string;
};

export type FileItem = {
  fid: string;
  name: string;
  isDir: boolean;
  size: number;
  updatedAt: number;
};

export type FilePage = {
  items: FileItem[];
  total: number;
};

export type Share = {
  id: string;
  /** 归属用户，老数据由第一个注册用户继承 */
  userId?: string;
  accountId: string;
  shareId: string;
  title: string;
  url: string;
  passcode: string;
  fids: string[];
  createdAt: string;
  groupId: string | null;
};

export type ShareGroup = {
  id: string;
  userId?: string;
  name: string;
  createdAt: string;
};

export type Capacity = {
  total: number;
  used: number;
  memberType: string;
  /** 容量构成，如 { 签到奖励: 251658240 } */
  composition: { label: string; size: number }[];
  expiresAt: string | null;
  /** 转存次数额度 */
  saveQuota: { used: number; total: number } | null;
};

export type Session = {
  user: PublicUser | null;
  accounts: Account[];
  activeId: string | null;
};

/**
 * 资源站条目：登记一条别人的分享，用户点「获取」时后端自动转存到号主网盘，
 * 再生成号主自己的分享链接返回。
 */
export type Resource = {
  id: string;
  userId: string;
  title: string;
  description: string;
  /** 原始分享链接（别人的） */
  sourceUrl: string;
  sourcePasscode: string;
  platform: Platform;
  /** 转存到号主网盘的哪个目录 */
  toPdir: string;
  /** 转存并重新分享后得到的链接，第一次获取时生成 */
  ownUrl: string | null;
  ownPasscode: string | null;
  /** 已转存文件的 fid，用于建分享 */
  ownFids: string[] | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
  hits: number;
  createdAt: string;
  updatedAt: string;
};
