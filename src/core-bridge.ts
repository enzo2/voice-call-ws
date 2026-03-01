// NOTE: This extension is intended to be publishable. Avoid depending on
// OpenClaw internal dist module layout (hashed filenames, private modules).
//
// core-bridge.ts is kept only for type compatibility with the plugin host.

export type CoreConfig = {
  session?: {
    store?: string;
  };
};
