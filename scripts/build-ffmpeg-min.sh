#!/bin/bash
# Builds the trimmed ffmpeg.exe that Buffer ships (about 18 MB instead of the 100 MB "essentials" build).
# It holds only what Buffer runs: ddagrab/gfxcapture/gdigrab capture, NVENC/AMF/QuickSync/x264 encoding, AAC,
# MP4/MKV/MPEG-TS/segment muxing, the decoders for the common clip formats, and the filters of the exporter.
#
# Needs MSYS2 (winget install MSYS2.MSYS2) with, in the MINGW64 shell:
#   pacman -S make diffutils tar xz curl nasm mingw-w64-x86_64-{gcc,pkgconf,x264,dav1d,ffnvcodec-headers,amf-headers,libvpl}
# Usage (MSYS2 MINGW64 shell):  bash scripts/build-ffmpeg-min.sh [work-dir]
# Result: <work-dir>/ffmpeg-9.0.2/ffmpeg.exe.  The build is GPL v3 (libx264); the source is the unmodified
# release tarball from https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz, so this script plus that tarball is the
# corresponding source.  The binary is published as the "ffmpeg-9.0.2-min-1" release of this repository.
set -e
VER=9.0.2
WORK="${1:-/c/ffbuild}"
mkdir -p "$WORK"
cd "$WORK"
[ -f ffmpeg-$VER.tar.xz ] || curl -fL -o ffmpeg-$VER.tar.xz https://ffmpeg.org/releases/ffmpeg-$VER.tar.xz
[ -d ffmpeg-$VER ] || tar xf ffmpeg-$VER.tar.xz
cd ffmpeg-$VER
make distclean >/dev/null 2>&1 || true
./configure \
  --pkg-config-flags=--static --extra-ldflags="-static" --extra-libs="-lstdc++ -lole32 -lgdi32 -luuid" \
  --enable-gpl --enable-version3 --enable-static --disable-shared \
  --disable-debug --disable-doc --disable-ffplay --disable-ffprobe \
  --disable-autodetect --disable-everything --disable-iconv \
  --enable-zlib --enable-libx264 --enable-libdav1d \
  --enable-d3d11va --enable-dxva2 --enable-ffnvcodec --enable-nvenc --enable-nvdec --enable-amf --enable-libvpl \
  --enable-protocol=file,pipe,tcp,concat \
  --enable-demuxer=mov,matroska,mpegts,avi,flv,concat,pcm_f32le,mp3,aac,wav,ogg,flac,h264,hevc,ivf,lavfi \
  --enable-indev=gdigrab,lavfi \
  --enable-muxer=mp4,mov,ipod,matroska,mpegts,segment,null,image2,pcm_s16le,adts,wav \
  --enable-decoder=h264,hevc,vp8,vp9,av1,libdav1d,mpeg4,mpeg2video,mpeg1video,h263,aac,aac_latm,mp3,mp3float,opus,vorbis,flac,pcm_s16le,pcm_s16be,pcm_f32le,pcm_s24le,pcm_s32le,pcm_u8,rawvideo,mjpeg,wrapped_avframe \
  --enable-encoder=aac,libx264,h264_nvenc,hevc_nvenc,h264_amf,h264_qsv,mjpeg,pcm_s16le,rawvideo,wrapped_avframe \
  --enable-parser=h264,hevc,aac,aac_latm,vp8,vp9,av1,mpegaudio,mpegvideo,opus,vorbis,flac,mpeg4video,mjpeg \
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,null,vp9_superframe,vp9_superframe_split,av1_frame_merge,av1_frame_split \
  --enable-hwaccel=h264_d3d11va,h264_d3d11va2,h264_dxva2,h264_nvdec,hevc_d3d11va,hevc_d3d11va2,hevc_dxva2,hevc_nvdec,vp9_d3d11va,vp9_d3d11va2,vp9_dxva2,vp9_nvdec,av1_d3d11va,av1_d3d11va2,av1_dxva2,av1_nvdec \
  --enable-filter=buffer,abuffer,buffersink,abuffersink,fifo,afifo,scale,fps,format,hwdownload,hwupload,hwmap,crop,setpts,asetpts,volume,amix,atempo,loudnorm,aresample,aformat,anull,null,color,ddagrab,gfxcapture,split,asplit,anullsrc,pad,setsar,trim,atrim
make -j"$(nproc)"
ls -la ffmpeg.exe
sha256sum ffmpeg.exe
