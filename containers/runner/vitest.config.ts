import { defineConfig } from "vitest/config";
import { timeouts } from "../../vitest.shared";

export default defineConfig({ test: timeouts });
