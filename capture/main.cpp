/**
 * WASAPI Loopback capture → Float32 stereo PCM on stdout.
 * Config / logs go to stderr as JSON lines.
 *
 * Protocol:
 *   stderr: {"type":"audio-config","sampleRate":N,"channels":2,"format":"f32"}
 *   stdout: interleaved Float32 PCM (little-endian), continuous
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <mmreg.h>
#include <avrt.h>

#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")

#ifndef KSDATAFORMAT_SUBTYPE_PCM
// Fallback GUIDs if ksmedia.h is unavailable
static const GUID KSDATAFORMAT_SUBTYPE_PCM = {
    0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
#endif
#ifndef KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
static const GUID KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = {
    0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
#endif

namespace {

constexpr REFERENCE_TIME kBufferDuration = 20 * 10000; // 20ms in 100-ns units

std::atomic<bool> g_running{true};

BOOL WINAPI ConsoleHandler(DWORD type) {
  if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT) {
    g_running = false;
    return TRUE;
  }
  return FALSE;
}

void LogJson(const std::string& json) {
  std::fputs(json.c_str(), stderr);
  std::fputc('\n', stderr);
  std::fflush(stderr);
}

void Fail(const char* msg, HRESULT hr = S_OK) {
  char buf[512];
  if (FAILED(hr)) {
    std::snprintf(buf, sizeof(buf),
                  "{\"type\":\"error\",\"message\":\"%s\",\"hr\":%ld}", msg,
                  static_cast<long>(hr));
  } else {
    std::snprintf(buf, sizeof(buf), "{\"type\":\"error\",\"message\":\"%s\"}", msg);
  }
  LogJson(buf);
}

template <typename T>
void SafeRelease(T** pp) {
  if (pp && *pp) {
    (*pp)->Release();
    *pp = nullptr;
  }
}

HRESULT GetMixFormat(IMMDevice* device, WAVEFORMATEX** format) {
  IAudioClient* client = nullptr;
  HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                reinterpret_cast<void**>(&client));
  if (FAILED(hr)) return hr;
  hr = client->GetMixFormat(format);
  SafeRelease(&client);
  return hr;
}

bool IsFloatFormat(const WAVEFORMATEX* wfx) {
  if (wfx->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
  if (wfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wfx);
    return IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
  }
  return false;
}

bool IsPcmFormat(const WAVEFORMATEX* wfx) {
  if (wfx->wFormatTag == WAVE_FORMAT_PCM) return true;
  if (wfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wfx);
    return IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM);
  }
  return false;
}

void ConvertToStereoF32(const BYTE* src, UINT32 frames, const WAVEFORMATEX* wfx,
                        std::vector<float>* out) {
  const WORD channels = wfx->nChannels;
  const WORD bits = wfx->wBitsPerSample;
  out->resize(static_cast<size_t>(frames) * 2);

  if (IsFloatFormat(wfx) && bits == 32) {
    const float* in = reinterpret_cast<const float*>(src);
    for (UINT32 i = 0; i < frames; ++i) {
      float L = in[i * channels];
      float R = channels > 1 ? in[i * channels + 1] : L;
      (*out)[i * 2] = L;
      (*out)[i * 2 + 1] = R;
    }
    return;
  }

  if (IsPcmFormat(wfx) && bits == 16) {
    const int16_t* in = reinterpret_cast<const int16_t*>(src);
    constexpr float scale = 1.0f / 32768.0f;
    for (UINT32 i = 0; i < frames; ++i) {
      float L = in[i * channels] * scale;
      float R = channels > 1 ? in[i * channels + 1] * scale : L;
      (*out)[i * 2] = L;
      (*out)[i * 2 + 1] = R;
    }
    return;
  }

  if (IsPcmFormat(wfx) && bits == 24) {
    for (UINT32 i = 0; i < frames; ++i) {
      auto read24 = [&](WORD ch) -> float {
        const BYTE* p = src + (i * channels + ch) * 3;
        int32_t v = (static_cast<int32_t>(p[2]) << 16) |
                    (static_cast<int32_t>(p[1]) << 8) | p[0];
        if (v & 0x800000) v |= ~0xFFFFFF;
        return static_cast<float>(v) / 8388608.0f;
      };
      float L = read24(0);
      float R = channels > 1 ? read24(1) : L;
      (*out)[i * 2] = L;
      (*out)[i * 2 + 1] = R;
    }
    return;
  }

  if (IsPcmFormat(wfx) && bits == 32) {
    const int32_t* in = reinterpret_cast<const int32_t*>(src);
    constexpr float scale = 1.0f / 2147483648.0f;
    for (UINT32 i = 0; i < frames; ++i) {
      float L = in[i * channels] * scale;
      float R = channels > 1 ? in[i * channels + 1] * scale : L;
      (*out)[i * 2] = L;
      (*out)[i * 2 + 1] = R;
    }
    return;
  }

  // Unsupported: silence
  std::fill(out->begin(), out->end(), 0.0f);
}

}  // namespace

int main() {
  SetConsoleCtrlHandler(ConsoleHandler, TRUE);
  SetConsoleOutputCP(CP_UTF8);

  // Binary mode for stdout so PCM is not corrupted by CRLF
  _setmode(_fileno(stdout), _O_BINARY);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    Fail("CoInitializeEx failed", hr);
    return 1;
  }

  IMMDeviceEnumerator* enumerator = nullptr;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                        __uuidof(IMMDeviceEnumerator),
                        reinterpret_cast<void**>(&enumerator));
  if (FAILED(hr)) {
    Fail("CoCreateInstance MMDeviceEnumerator failed", hr);
    CoUninitialize();
    return 1;
  }

  IMMDevice* device = nullptr;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (FAILED(hr)) {
    Fail("GetDefaultAudioEndpoint failed", hr);
    SafeRelease(&enumerator);
    CoUninitialize();
    return 1;
  }

  WAVEFORMATEX* mixFormat = nullptr;
  hr = GetMixFormat(device, &mixFormat);
  if (FAILED(hr) || !mixFormat) {
    Fail("GetMixFormat failed", hr);
    SafeRelease(&device);
    SafeRelease(&enumerator);
    CoUninitialize();
    return 1;
  }

  IAudioClient* audioClient = nullptr;
  hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                        reinterpret_cast<void**>(&audioClient));
  if (FAILED(hr)) {
    Fail("Activate IAudioClient failed", hr);
    CoTaskMemFree(mixFormat);
    SafeRelease(&device);
    SafeRelease(&enumerator);
    CoUninitialize();
    return 1;
  }

  // Event-driven shared-mode loopback (Win10 1703+)
  DWORD streamFlags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  hr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags,
                               kBufferDuration, 0, mixFormat, nullptr);

  // Fallback without EVENTCALLBACK for older builds
  if (FAILED(hr)) {
    streamFlags = AUDCLNT_STREAMFLAGS_LOOPBACK;
    hr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags,
                                 kBufferDuration, 0, mixFormat, nullptr);
  }
  if (FAILED(hr)) {
    Fail("IAudioClient::Initialize (loopback) failed", hr);
    SafeRelease(&audioClient);
    CoTaskMemFree(mixFormat);
    SafeRelease(&device);
    SafeRelease(&enumerator);
    CoUninitialize();
    return 1;
  }

  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!event) {
    Fail("CreateEvent failed");
    SafeRelease(&audioClient);
    CoTaskMemFree(mixFormat);
    SafeRelease(&device);
    SafeRelease(&enumerator);
    CoUninitialize();
    return 1;
  }

  const bool eventDriven = (streamFlags & AUDCLNT_STREAMFLAGS_EVENTCALLBACK) != 0;
  if (eventDriven) {
    hr = audioClient->SetEventHandle(event);
    if (FAILED(hr)) {
      Fail("SetEventHandle failed", hr);
      CloseHandle(event);
      SafeRelease(&audioClient);
      CoTaskMemFree(mixFormat);
      SafeRelease(&device);
      SafeRelease(&enumerator);
      CoUninitialize();
      return 1;
    }
  }

  IAudioCaptureClient* capture = nullptr;
  hr = audioClient->GetService(__uuidof(IAudioCaptureClient),
                               reinterpret_cast<void**>(&capture));
  if (FAILED(hr)) {
    Fail("GetService IAudioCaptureClient failed", hr);
    CloseHandle(event);
    SafeRelease(&audioClient);
    CoTaskMemFree(mixFormat);
    SafeRelease(&device);
    SafeRelease(&enumerator);
    CoUninitialize();
    return 1;
  }

  DWORD taskIndex = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

  char config[256];
  std::snprintf(config, sizeof(config),
                "{\"type\":\"audio-config\",\"sampleRate\":%u,\"channels\":2,\"format\":\"f32\"}",
                static_cast<unsigned>(mixFormat->nSamplesPerSec));
  LogJson(config);
  LogJson("{\"type\":\"status\",\"message\":\"capture started\"}");

  hr = audioClient->Start();
  if (FAILED(hr)) {
    Fail("IAudioClient::Start failed", hr);
    if (task) AvRevertMmThreadCharacteristics(task);
    SafeRelease(&capture);
    CloseHandle(event);
    SafeRelease(&audioClient);
    CoTaskMemFree(mixFormat);
    SafeRelease(&device);
    SafeRelease(&enumerator);
    CoUninitialize();
    return 1;
  }

  std::vector<float> pcm;
  while (g_running) {
    if (eventDriven) {
      DWORD wait = WaitForSingleObject(event, 2000);
      if (wait == WAIT_TIMEOUT) continue;
      if (wait != WAIT_OBJECT_0) break;
    } else {
      Sleep(10);
    }

    UINT32 packetLength = 0;
    hr = capture->GetNextPacketSize(&packetLength);
    if (FAILED(hr)) break;

    while (packetLength > 0 && g_running) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;

      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;

      if (frames > 0) {
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          pcm.assign(static_cast<size_t>(frames) * 2, 0.0f);
        } else {
          ConvertToStereoF32(data, frames, mixFormat, &pcm);
        }

        const size_t bytes = pcm.size() * sizeof(float);
        const size_t written =
            fwrite(pcm.data(), 1, bytes, stdout);
        if (written != bytes) {
          g_running = false;
          capture->ReleaseBuffer(frames);
          break;
        }
        fflush(stdout);
      }

      capture->ReleaseBuffer(frames);
      hr = capture->GetNextPacketSize(&packetLength);
      if (FAILED(hr)) break;
    }
  }

  audioClient->Stop();
  LogJson("{\"type\":\"status\",\"message\":\"capture stopped\"}");

  if (task) AvRevertMmThreadCharacteristics(task);
  SafeRelease(&capture);
  CloseHandle(event);
  SafeRelease(&audioClient);
  CoTaskMemFree(mixFormat);
  SafeRelease(&device);
  SafeRelease(&enumerator);
  CoUninitialize();
  return 0;
}
