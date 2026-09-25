import { configDefaults, defineConfig } from "vitest/config";

// Agent worktrees are full checkouts nested in the repo; without this their tests run too.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".worktrees/**", ".claude/**"] },
});
