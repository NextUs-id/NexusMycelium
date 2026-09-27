import { z } from "zod";

export const PERMISSION_NAMES = ["fs.read", "fs.write", "shell", "network"] as const;
export const PermissionSchema = z.enum(PERMISSION_NAMES);
export type Permission = z.infer<typeof PermissionSchema>;

export const PLUGIN_API_VERSION = 1 as const;

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const pluginNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a canonical kebab-case plugin name");
const versionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/, "use semver x.y.z");
const capabilitySchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim() === value &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) &&
      !unsafeKeys.has(value),
    "must be a non-empty safe capability name",
  );

function unique<T extends z.ZodType>(item: T) {
  return z.array(item).superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const key = String(value);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "must be unique",
        });
      }
      seen.add(key);
    });
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const ManifestShape = z
  .object({
    name: pluginNameSchema,
    version: versionSchema,
    apiVersion: z.literal(PLUGIN_API_VERSION),
    description: z.string().default(""),
    provides: unique(capabilitySchema).default(() => []),
    /** Official dependencies; a dependent receives the full provides closure of each dependency. */
    requires: unique(pluginNameSchema).default(() => []),
    permissions: unique(PermissionSchema).default(() => []),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.requires.includes(manifest.name)) {
      context.addIssue({
        code: "custom",
        path: ["requires"],
        message: "plugin cannot require itself",
      });
    }
  });

export const PluginManifestSchema = ManifestShape.transform((manifest) => deepFreeze(manifest));

export type PluginManifest = Omit<z.infer<typeof ManifestShape>, "provides" | "requires" | "permissions"> & {
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly permissions: readonly Permission[];
};
export type PluginManifestInput = z.input<typeof ManifestShape>;
