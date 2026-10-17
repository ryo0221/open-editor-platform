/* Isolated test bridge; not a product API. Linked FFmpeg retains LGPL notices. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <malloc.h>
#include <emscripten.h>
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libavutil/md5.h>
#include <libavutil/pixdesc.h>
static AVFormatContext *format;
static AVIOContext *io;
static AVCodecContext *codec;
static AVPacket *packet;
static AVFrame *frame;
static int64_t cursor, input_size, total_read;
static int video, packets, packet_limit, draining, ended, defer_receive, fault_stage;
/* Test-only fault controls and allocator accounting, never a product API. */
EMSCRIPTEN_KEEPALIVE void set_fault(int stage) { fault_stage=stage; }
EMSCRIPTEN_KEEPALIVE int live_handles(void) { return !!format+!!io+!!codec+!!packet+!!frame; }
EMSCRIPTEN_KEEPALIVE int heap_used(void) { return mallinfo().uordblks; }
EMSCRIPTEN_KEEPALIVE void set_defer_receive(int enabled) { defer_receive=enabled; }
EM_JS(void, event, (const char *name), { (Module.events || (Module.events = [])).push(UTF8ToString(name)); });
EM_JS(int, copy_input, (int offset, uint8_t *out, int count), {
  HEAPU8.set(Module.input.subarray(offset, offset + count), out); return count;
});
EM_JS(void, record_frame, (double pts, double duration, int num, int den, int width, int height, const char *pixel, const char *md5, int primaries, int transfer, int matrix, int range), {
 Module.frames.push({pts,duration,num,den,width,height,pixel:UTF8ToString(pixel),md5:UTF8ToString(md5),primaries,transfer,matrix,range});
});
static int read_input(void *opaque, uint8_t *out, int size) {
 (void)opaque;
 if(fault_stage==10)return AVERROR(EIO);
 if (cursor >= input_size) return AVERROR_EOF;
 if (size > input_size-cursor) size = input_size-cursor;
 if ((total_read += size) > input_size*8+65536) return AVERROR(EIO);
 copy_input(cursor,out,size); cursor+=size;return size;
}
static int64_t seek_input(void *opaque,int64_t offset,int whence) {
 (void)opaque;if(whence==AVSEEK_SIZE) return input_size;
 int64_t next = whence==SEEK_SET?offset:whence==SEEK_CUR?cursor+offset:whence==SEEK_END?input_size+offset:-1;
 if(next<0||next>input_size) return AVERROR(EINVAL);return cursor=next;
}
EMSCRIPTEN_KEEPALIVE void close_input(void) {
 av_packet_free(&packet);av_frame_free(&frame);avcodec_free_context(&codec);
 avformat_close_input(&format);if(io){av_freep(&io->buffer);avio_context_free(&io);}ended=1;
}
static int open_input_impl(int size,int limit) {
 close_input();cursor=total_read=0;input_size=size;packets=draining=ended=0;packet_limit=limit;
 if(size<=0||size>16*1024*1024||limit<1||limit>1000)return -100;
 format=fault_stage==1?NULL:avformat_alloc_context();if(!format)return -101;
 uint8_t *io_buffer=fault_stage==2?NULL:av_malloc(32768);if(!io_buffer)return -102;
 io=fault_stage==3?NULL:avio_alloc_context(io_buffer,32768,0,NULL,read_input,NULL,seek_input);
 if(!io){av_free(io_buffer);return -102;}
 format->pb=io;format->flags|=AVFMT_FLAG_CUSTOM_IO;format->probesize=1024*1024;
 int r=avformat_open_input(&format,NULL,NULL,NULL);if(r<0)return r;
 r=avformat_find_stream_info(format,NULL);if(r<0)return r;
 video=av_find_best_stream(format,AVMEDIA_TYPE_VIDEO,-1,-1,NULL,0);if(video<0)return video;
 const AVCodec *decoder=avcodec_find_decoder(format->streams[video]->codecpar->codec_id);if(!decoder)return -103;
 codec=fault_stage==4?NULL:avcodec_alloc_context3(decoder);if(!codec)return -104;
 r=fault_stage==5?AVERROR(ENOMEM):avcodec_parameters_to_context(codec,format->streams[video]->codecpar);if(r<0)return r;
 codec->thread_count=1;codec->max_pixels=3840*2160;
 if(codec->extradata_size>1024*1024)return -110;
 if(codec->extradata)for(int i=0;i<AV_INPUT_BUFFER_PADDING_SIZE;i++)if(codec->extradata[codec->extradata_size+i])return -111;
 r=fault_stage==6?AVERROR(ENOMEM):avcodec_open2(codec,decoder,NULL);if(r<0)return r;
 packet=fault_stage==7?NULL:av_packet_alloc();frame=fault_stage==8?NULL:av_frame_alloc();return packet&&frame?0:-105;
}
EMSCRIPTEN_KEEPALIVE int open_input(int size,int limit) {
 int r=open_input_impl(size,limit);if(r<0)close_input();return r;
}
static int receive_frames(void) {
 int r;
 while((r=avcodec_receive_frame(codec,frame))>=0){
  int size=av_image_get_buffer_size(frame->format,frame->width,frame->height,1);
  if(size<0||size>64*1024*1024)return -106;
  uint8_t *data=fault_stage==9?NULL:av_malloc(size), digest[16];char hash[33];if(!data)return -107;
  int copied=av_image_copy_to_buffer(data,size,(const uint8_t* const*)frame->data,frame->linesize,frame->format,frame->width,frame->height,1);
  if(copied<0){av_free(data);return copied;}
  av_md5_sum(digest,data,size);av_free(data);
  for(int i=0;i<16;i++)sprintf(hash+i*2,"%02x",digest[i]);
  AVRational tb=format->streams[video]->time_base;
  record_frame(frame->best_effort_timestamp,frame->duration,tb.num,tb.den,frame->width,frame->height,av_get_pix_fmt_name(frame->format),hash,frame->color_primaries,frame->color_trc,frame->colorspace,frame->color_range);
  av_frame_unref(frame);
 }
 return r;
}
static int decode_step_impl(void) {
 if(!codec||ended)return -108;
 int r;
 while((r=av_read_frame(format,packet))>=0){
  if(++packets>packet_limit){av_packet_unref(packet);return -109;}
  if(packet->stream_index!=video){av_packet_unref(packet);continue;}
  if(!packet->buf||packet->data+packet->size+AV_INPUT_BUFFER_PADDING_SIZE>packet->buf->data+packet->buf->size){av_packet_unref(packet);return -112;}
  for(int i=0;i<AV_INPUT_BUFFER_PADDING_SIZE;i++)if(packet->data[packet->size+i]){av_packet_unref(packet);return -113;}
  r=avcodec_send_packet(codec,packet);
  if(r==AVERROR(EAGAIN)){
   event("send-eagain");int received=receive_frames();if(received!=AVERROR(EAGAIN)){av_packet_unref(packet);return received;}
   r=avcodec_send_packet(codec,packet);if(r>=0)event("packet-resent");
  }
  av_packet_unref(packet);if(r<0)return r;
  if(defer_receive)return 0;
  r=receive_frames();return r==AVERROR(EAGAIN)?0:r;
 }
 if(r!=AVERROR_EOF)return r;
 if(!draining){
  r=avcodec_send_packet(codec,NULL);
  if(r==AVERROR(EAGAIN)){
   event("flush-eagain");int received=receive_frames();if(received!=AVERROR(EAGAIN))return received;
   r=avcodec_send_packet(codec,NULL);
  }
  if(r<0)return r;draining=1;event("flush-sent");
  r=receive_frames();if(r!=AVERROR_EOF)return r==AVERROR(EAGAIN)?-114:r;
  event("decoder-eof");
 }
 ended=1;return 1;
}

EMSCRIPTEN_KEEPALIVE int decode_step(void) {
 int r=decode_step_impl();if(r!=0)close_input();return r;
}
