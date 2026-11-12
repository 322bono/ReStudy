export type MemberPermissions = {
  active: boolean;
  ai: boolean;
  personalKeys: boolean;
  sharedKeys: boolean;
  mistakes: boolean;
  study: boolean;
};

export type AccountAccess = MemberPermissions & { administrator: boolean };

export const defaultMemberPermissions: MemberPermissions = {
  active: true,
  ai: false,
  personalKeys: false,
  sharedKeys: false,
  mistakes: true,
  study: true,
};
