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
// Освобождать — zali_bus_free_string.
char* zali_apm_stats_json(ZaliApm* apm);

#endif /* CoreBridge_h */
