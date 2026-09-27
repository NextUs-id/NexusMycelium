import { PERMISSION_NAMES, type Permission } from "./manifest.js";

export type PermissionPolicy = "allow" | "ask" | "deny";
export type PermissionAsk = (permission: Permission, action: string) => boolean | Promise<boolean>;

export const DEFAULT_PERMISSION_POLICIES: Readonly<Record<Permission, PermissionPolicy>> = {
  "fs.read": "allow",
  "fs.write": "deny",
  shell: "deny",
  network: "deny",
};

const permissionSet = new Set<string>(PERMISSION_NAMES);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && permissionSet.has(value);
}

function isPolicy(value: unknown): value is PermissionPolicy {
  return value === "allow" || value === "ask" || value === "deny";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function label(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<invalid>";
  }
}

export class PermissionDeniedError extends Error {
  readonly code = "PERMISSION_DENIED";
  readonly context: Readonly<{
    permission: string;
    action: string;
    reason: "unknown" | "denied" | "approval" | "policy";
  }>;

  constructor(
    readonly permission: string,
    readonly action: string,
    reason: "unknown" | "denied" | "approval" | "policy" = "denied",
  ) {
    super(`permission denied: ${permission} (${action})`);
    this.name = "PermissionDeniedError";
    this.context = Object.freeze({ permission, action, reason });
  }
}

export class PermissionGate {
  private readonly policies: Record<Permission, PermissionPolicy>;
  private readonly ask: PermissionAsk;
  private readonly allowed: ReadonlySet<Permission> | undefined;
  private readonly invalidConfiguration: boolean;

  constructor(
    policies: Partial<Record<Permission, PermissionPolicy>> = {},
    ask: PermissionAsk = () => false,
    allowed?: Iterable<Permission>,
    invalidConfiguration = false,
  ) {
    this.policies = { ...DEFAULT_PERMISSION_POLICIES };
    this.ask = typeof ask === "function" ? ask : () => false;
    let invalid = invalidConfiguration;
    if (!isRecord(policies)) {
      invalid = true;
    } else {
      for (const key of Reflect.ownKeys(policies)) {
        if (typeof key !== "string" || !isPermission(key)) {
          invalid = true;
          continue;
        }
        const policy = policies[key];
        if (!isPolicy(policy)) {
          this.policies[key] = "deny";
          invalid = true;
        } else {
          this.policies[key] = policy;
        }
      }
    }
    if (allowed === undefined) {
      this.allowed = undefined;
    } else {
      const scoped = new Set<Permission>();
      try {
        for (const permission of allowed) {
          if (!isPermission(permission)) {
            invalid = true;
            continue;
          }
          scoped.add(permission);
        }
      } catch {
        invalid = true;
      }
      this.allowed = invalid ? new Set<Permission>() : scoped;
    }
    this.invalidConfiguration = invalid;
  }

  scope(permissions: Iterable<Permission>): PermissionGate {
    const requested = new Set<Permission>();
    try {
      for (const permission of permissions) {
        if (!isPermission(permission)) {
          throw new PermissionDeniedError(label(permission), "<scope>", "unknown");
        }
        requested.add(permission);
      }
    } catch (error) {
      if (error instanceof PermissionDeniedError) throw error;
      throw new PermissionDeniedError("<scope>", "<scope>", "unknown");
    }
    const allowed =
      this.allowed === undefined
        ? requested
        : new Set([...this.allowed].filter((permission) => requested.has(permission)));
    return new PermissionGate(this.policies, this.ask, allowed, this.invalidConfiguration);
  }

  decision(permission: Permission): PermissionPolicy {
    if (!isPermission(permission) || this.invalidConfiguration) return "deny";
    if (this.allowed !== undefined && !this.allowed.has(permission)) return "deny";
    return this.policies[permission];
  }

  async check(permission: Permission, action: string): Promise<void> {
    if (!isPermission(permission)) {
      throw new PermissionDeniedError(label(permission), action, "unknown");
    }
    if (this.invalidConfiguration) {
      throw new PermissionDeniedError(permission, action, "policy");
    }
    const decision = this.decision(permission);
    if (decision === "allow") return;
    if (decision === "ask") {
      let approved: boolean;
      try {
        approved = (await this.ask(permission, action)) === true;
      } catch {
        approved = false;
      }
      if (approved) return;
      throw new PermissionDeniedError(permission, action, "approval");
    }
    throw new PermissionDeniedError(permission, action, "denied");
  }
}
