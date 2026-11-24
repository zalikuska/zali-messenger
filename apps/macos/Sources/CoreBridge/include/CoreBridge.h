#ifndef CoreBridge_h
#define CoreBridge_h

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool zali_pack_message(const char* sender, const char* text, const char* output);
bool zali_unpack_message(const char* archive_path, const char* temp_dir, char* out_sender, size_t out_sender_max_len, char* out_text, size_t out_text_max_len);

char* zali_bus_dispatch(const char* address_command, const char* args_json);
void zali_bus_free_string(char* ptr);

// Обработка голоса нативного захвата микрофона (core/src/audio_processing.rs, фича `apm`):
// AEC3 → RNNoise → AGC2, 48 кГц моно f32. Опорный сигнал и микрофон можно звать из
// разных потоков — внутри мьютекс.
typedef struct ZaliApm ZaliApm;
ZaliApm* zali_apm_new(bool aec, bool ns, bool agc);
void zali_apm_free(ZaliApm* apm);
void zali_apm_set_config(ZaliApm* apm, bool aec, bool ns, bool agc);
void zali_apm_push_render(ZaliApm* apm, const float* samples, size_t frames, uint32_t channels);
size_t zali_apm_process_capture(ZaliApm* apm, const float* input, size_t frames, float* out, size_t out_cap);
// С метками времени первого отсчёта (host time, нс): опорный сигнал склеивается с микрофоном по времени.
void zali_apm_push_render_at(ZaliApm* apm, const float* samples, size_t frames, uint32_t channels, int64_t ts_ns);
size_t zali_apm_process_capture_at(ZaliApm* apm, const float* input, size_t frames, int64_t ts_ns, float* out, size_t out_cap);
// Освобождать — zali_bus_free_string.
char* zali_apm_stats_json(ZaliApm* apm);

// Нативная отправка экрана на SFU (core/src/sfu_publisher.rs, фича `sfu`): клиент WebRTC
// на str0m шлёт готовые слои H.264 мимо WebView. Колбэк — JSON-события с потока издателя;
// после zali_sfu_pub_free он больше не зовётся.
typedef struct ZaliSfuPub ZaliSfuPub;
typedef void (*ZaliSfuPubCallback)(void* ctx, const char* json);
ZaliSfuPub* zali_sfu_pub_new(const char* config_json, ZaliSfuPubCallback callback, void* ctx);
// {"sdp":"...","mid":"..."}; освобождать — zali_bus_free_string.
char* zali_sfu_pub_offer_json(const ZaliSfuPub* p);
bool zali_sfu_pub_answer(const ZaliSfuPub* p, const char* sdp);
void zali_sfu_pub_push(const ZaliSfuPub* p, uint32_t layer, const uint8_t* data, size_t len, bool keyframe, int64_t pts_us);
void zali_sfu_pub_free(ZaliSfuPub* p);

#endif /* CoreBridge_h */
