import { z } from "zod";

/** Permissions a plugin may request. The kernel enforces them (Task 1.5). */
export const PermissionSchema = z.enum(["fs.read", "fs.write", "shell", "network"]);
export type Permission = z.infer<typeof PermissionSchema>;

/** Current plugin API version. Bump only with a documented migration. */
export const PLUGIN_API_VERSION = 1 as const;

export const PluginManifestSchema = z.object({
  /** Unique kebab-case name, e.g. "loop-react". */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use kebab-case"),
  /** Plugin's own semver, e.g. "0.1.0". */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "use semver x.y.z"),
  /** Kernel plugin API this plugin targets. */
  apiVersion: z.literal(PLUGIN_API_VERSION),
  description: z.string().default(""),
  /** Capabilities this plugin offers, e.g. ["loop", "tool:fs"]. */
  provides: z.array(z.string()).default([]),
  /** Plugin names that must be loaded first. */
  requires: z.array(z.string()).default([]),
  permissions: z.array(PermissionSchema).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginManifestInput = z.input<typeof PluginManifestSchema>;
