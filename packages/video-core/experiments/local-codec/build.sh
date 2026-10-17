#!/usr/bin/env bash
# Isolated experiment only. Existing, verified source/toolchain paths are required.
set -euo pipefail
codec_source="${1:?FFmpeg source}"
codec_sdk="${2:?emsdk root}"
codec_output="${3:?external build output}"
codec_bridge="$(cd "$(dirname "$0")" && pwd)/decode.c"
test "$(git -C "$codec_source" rev-parse HEAD)" = 3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587
test "$(git -C "$codec_sdk" rev-parse HEAD)" = 62a853cd3b3134398ce85cde8bb5cbb2ef0194cb
mkdir -p "$codec_output/build"
cd "$codec_output/build"
"$codec_sdk/upstream/emscripten/emconfigure" "$codec_source/configure" \
 --prefix="$codec_output/install" \
 --cc="$codec_sdk/upstream/emscripten/emcc" --cxx="$codec_sdk/upstream/emscripten/em++" \
 --ar="$codec_sdk/upstream/emscripten/emar" --ranlib="$codec_sdk/upstream/emscripten/emranlib" \
 --target-os=none --arch=wasm32 --enable-cross-compile \
 --disable-asm --disable-x86asm --disable-inline-asm --disable-programs --disable-doc \
 --disable-debug --disable-autodetect --disable-network --disable-pthreads \
 --disable-w32threads --disable-os2threads --disable-gpl --disable-nonfree --disable-version3 \
 --disable-everything --disable-avdevice --disable-avfilter --disable-swscale \
 --disable-swresample --disable-postproc --enable-avcodec --enable-avformat --enable-avutil \
 --enable-decoder=hevc,h264,aac --enable-encoder=aac --enable-parser=hevc,h264,aac \
 --enable-demuxer=mov --extra-cflags=-O2
make -j4
"$codec_sdk/upstream/emscripten/emcc" "$codec_bridge" -I"$codec_source" -I. \
 libavformat/libavformat.a libavcodec/libavcodec.a libavutil/libavutil.a \
 -O2 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker -sALLOW_MEMORY_GROWTH=1 \
 -sMAXIMUM_MEMORY=268435456 -sINITIAL_MEMORY=33554432 -sFILESYSTEM=0 \
 -o "$codec_output/decode.mjs"
