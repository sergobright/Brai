import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsdoc from "eslint-plugin-jsdoc";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "src/features/app/**/*Model.ts",
      "src/features/app/hooks/**/*.ts",
      "src/features/app/navigation/useSectionSwipeNavigation.ts",
      "src/lib/**/*.ts",
      "src/shared/activities/**/*.ts",
      "src/shared/api/**/*.ts",
      "src/shared/platform/**/*.ts",
      "src/shared/storage/**/*.ts",
      "src/shared/time/**/*.ts",
      "src/shared/types/**/*.ts",
    ],
    plugins: {
      jsdoc,
    },
    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        {
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: false,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          publicOnly: {
            esm: true,
            cjs: true,
            window: false,
          },
          minLineCount: 20,
        },
      ],
      "jsdoc/require-description": "error",
      "jsdoc/check-alignment": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "android/.gradle/**",
    "android/**/build/**",
    "android/app/src/main/assets/public/**",
    "test-results/**",
    "playwright-report/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
