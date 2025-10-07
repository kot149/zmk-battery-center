import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactPlugin from "eslint-plugin-react";
import reactYouMightNotNeedAnEffect from "eslint-plugin-react-you-might-not-need-an-effect";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
	{
		ignores: ["dist/**", "node_modules/**", "src-tauri/**"],
	},
	js.configs.recommended,
	{
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				ecmaFeatures: {
					jsx: true,
				},
			},
			globals: {
				window: "readonly",
				document: "readonly",
				console: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				setInterval: "readonly",
				clearInterval: "readonly",
				navigator: "readonly",
				fetch: "readonly",
				Promise: "readonly",
				AbortController: "readonly",
				Blob: "readonly",
				URL: "readonly",
				HTMLElement: "readonly",
				HTMLButtonElement: "readonly",
				localStorage: "readonly",
				location: "readonly",
				process: "readonly",
				NodeJS: "readonly",
				React: "readonly",
			},
		},
		plugins: {
			"@typescript-eslint": tseslint,
			react: reactPlugin,
			"react-hooks": reactHooks,
			"react-you-might-not-need-an-effect": reactYouMightNotNeedAnEffect,
		},
		rules: {
			...tseslint.configs.recommended.rules,
			...reactPlugin.configs.recommended.rules,
			...reactHooks.configs.recommended.rules,
			...reactYouMightNotNeedAnEffect.configs.recommended.rules,
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "error",
			"react/react-in-jsx-scope": "off",
			"react/prop-types": "off",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
				},
			],
		},
		settings: {
			react: {
				version: "detect",
			},
		},
	},
];
