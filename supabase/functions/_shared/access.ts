import { defaultMemberPermissions, type AccountAccess } from "../../../src/domain/account-access.ts";
export type AccessContext = { access?: AccountAccess };

export const accessColumns = "administrator,active,ai,personal_keys,shared_keys,mistakes,study";

export function accountAccess(row?: {
  administrator: boolean;
  active: boolean;
  ai: boolean;
  personal_keys: boolean;
  shared_keys: boolean;
  mistakes: boolean;
  study: boolean;
} | null): AccountAccess {
  if (!row) return { ...defaultMemberPermissions, administrator: false };
  const { administrator, active, ai, personal_keys, shared_keys, mistakes, study } = row;
  return { administrator, active, ai, personalKeys: personal_keys, sharedKeys: shared_keys, mistakes, study };
}
