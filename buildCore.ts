import { execSync } from "node:child_process";
import fs from "node:fs";

let toolchain = "";
let profile = "debug";
let cargoFlags = "";
// Keep .github/workflows/ci.yml in sync with these flags, so wasm-opt works.
let rustFlags =
    "-C target-feature=+bulk-memory,+mutable-globals,+nontrapping-fptoint,+sign-ext,+simd128,+extended-const,+multivalue,+reference-types,+tail-call";
let wasmBindgenFlags = "--encode-into always --target web --reference-types";
const target = "wasm32-unknown-unknown";
const targetFolder = target;
const coreFeatures = [
    "parsing",
    "run-saving",
    "timing",
    "run-editing",
    "layouts",
    "layout-editing",
    "hotkeys",
    "web-command-sink",
    "server-protocol",
    "web-rendering",
    "therun-gg",
    "localization",
    "image-shrinking",
].join(",");
const bindingsDir = "target/livesplit-one-bindings";

if (process.argv.some((v) => v === "--max-opt")) {
    // Do a fully optimized build ready for deployment.
    profile = "max-opt";
    cargoFlags = "--profile max-opt";
} else if (process.argv.some((v) => v === "--release")) {
    // Do an optimized build.
    profile = "release";
    cargoFlags = "--release";
} else {
    // Do a debug build.
    wasmBindgenFlags += " --keep-debug";
}

// Use WASM features that may not be supported by all the browsers.
if (process.argv.some((v) => v === "--unstable")) {
    // Relaxed SIMD is not supported by Firefox and Safari yet.
    rustFlags += ",+relaxed-simd";

    // Not supported by any browser yet.
    rustFlags += ",+wide-arithmetic";
}

// Use the nightly toolchain, which enables some more optimizations.
if (process.argv.some((v) => v === "--nightly")) {
    toolchain = "+nightly";
    cargoFlags += " -Z build-std=std,panic_abort";
    rustFlags +=
        " -Z wasm-c-abi=spec -Z unstable-options -C panic=immediate-abort";

    // FIXME: Apparently the multivalue ABI is broken again.
    // Caused by: https://github.com/rust-lang/rust/pull/135534
    // target = "../wasm32-multivalue.json";
    // targetFolder = "wasm32-multivalue";

    // Virtual function elimination requires LTO, so we can only do it for
    // max-opt builds.
    if (profile == "max-opt") {
        // Seems like cargo itself calls rustc to check for file name patterns,
        // but it forgets to pass the LTO flag that we specified in the
        // Cargo.toml, so the virtual-function-elimination complains that it's
        // only compatible with LTO, so we have to specify lto here too.
        // FIXME: Seems to be broken at the moment.
        // rustFlags += " -Z virtual-function-elimination -C lto";
    }
}

execSync(
    `cargo ${toolchain} run -- --no-default-features --features ${coreFeatures} --output-dir ${bindingsDir}`,
    {
        cwd: "livesplit-core/capi/bind_gen",
        stdio: "inherit",
    },
);

execSync(
    `cargo ${toolchain} rustc -p livesplit-core-capi --crate-type cdylib --no-default-features --features ${coreFeatures} --target ${target} ${cargoFlags}`,
    {
        cwd: "livesplit-core",
        stdio: "inherit",
        env: {
            ...process.env,
            RUSTFLAGS: rustFlags,
        },
    },
);

execSync(
    `wasm-bindgen ${wasmBindgenFlags} livesplit-core/target/${targetFolder}/${profile}/livesplit_core.wasm --out-dir src/livesplit-core`,
    {
        stdio: "inherit",
    },
);

fs.createReadStream(
    `livesplit-core/capi/bind_gen/${bindingsDir}/wasm_bindgen/web/index.ts`,
).pipe(fs.createWriteStream("src/livesplit-core/index.ts"));

fs.createReadStream(
    `livesplit-core/capi/bind_gen/${bindingsDir}/wasm_bindgen/web/preload.ts`,
).pipe(fs.createWriteStream("src/livesplit-core/preload.ts"));
