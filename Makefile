# HereBeDragons — common dev commands.
# Thin wrappers over the npm scripts in package.json so you don't have to
# remember the exact invocations. Run `make help` for the list.

.DEFAULT_GOAL := help
.PHONY: help install dev serve build build-demo preview typecheck test test-watch lint format check clean

## help: list available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'

## install: install dependencies (npm ci if lockfile present, else npm install)
install:
	@if [ -f package-lock.json ]; then npm ci; else npm install; fi

## dev: start the Vite dev server and serve the example (http://localhost:5173)
dev: node_modules
	npm run dev

## serve: alias for `make dev`
serve: dev

## build: build the distributable library (dist/ + .d.ts type declarations)
build: node_modules
	npm run build

## build-demo: build the example app as a static bundle (dist/)
build-demo: node_modules
	npm run build:demo

## preview: build the example, then serve the production bundle locally
preview: build-demo
	npx vite preview

## typecheck: run the TypeScript compiler with no emit
typecheck: node_modules
	npm run typecheck

## test: run the test suite once
test: node_modules
	npm run test

## test-watch: run the test suite in watch mode
test-watch: node_modules
	npm run test:watch

## lint: run ESLint over src/ and test/
lint: node_modules
	npm run lint

## format: format src/ and test/ with Prettier
format: node_modules
	npm run format

## check: typecheck + lint + test (the pre-commit gate)
check: typecheck lint test

## clean: remove build output and the dependency cache
clean:
	rm -rf dist node_modules

# Internal: ensure deps are installed before targets that need them.
node_modules:
	@if [ -f package-lock.json ]; then npm ci; else npm install; fi
