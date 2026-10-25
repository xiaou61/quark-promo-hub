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
