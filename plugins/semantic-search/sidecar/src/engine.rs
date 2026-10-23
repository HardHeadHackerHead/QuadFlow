//! Embedding engines: a BERT sentence-transformer run with Candle (pure Rust),
//! and a built-in feature-hashing embedder that needs no download (offline
//! fallback, and what the e2e test uses).

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config as BertConfig};
use std::path::Path;
use tokenizers::Tokenizer;

/// CUDA compiled in and a device present.
pub fn is_cuda_available() -> bool {
    #[cfg(feature = "cuda")]
    {
        Device::new_cuda(0).is_ok()
    }
    #[cfg(not(feature = "cuda"))]
    {
        false
    }
}

/// Metal compiled in and a device present.
pub fn is_metal_available() -> bool {
    #[cfg(feature = "metal")]
    {
        Device::new_metal(0).is_ok()
    }
    #[cfg(not(feature = "metal"))]
    {
        false
    }
}

/// The device to run on: a GPU when requested and available, else the CPU.
fn get_device(use_gpu: bool) -> Device {
    if use_gpu {
        #[cfg(feature = "cuda")]
        match Device::new_cuda(0) {
            Ok(d) => return d,
            Err(e) => log::warn!("CUDA device unavailable: {e}"),
        }
        #[cfg(feature = "metal")]
        match Device::new_metal(0) {
            Ok(d) => return d,
            Err(e) => log::warn!("Metal device unavailable: {e}"),
        }
        #[cfg(not(any(feature = "cuda", feature = "metal")))]
        log::warn!("GPU requested but this sidecar was built without GPU support; using the CPU");
    }
    Device::Cpu
}

/// A loaded embedding model.
pub enum Embedder {
    Bert(BertEngine),
    Hashing(HashingEngine),
}

impl Embedder {
    pub fn device_name(&self) -> &str {
        match self {
            Embedder::Bert(b) => &b.device_name,
            Embedder::Hashing(_) => "CPU (hashing)",
        }
    }

    pub fn embed(&mut self, text: &str) -> Result<Vec<f32>, String> {
        let mut v = self.embed_batch(&[text.to_string()])?;
        v.pop().ok_or_else(|| "no embedding produced".to_string())
    }

    pub fn embed_batch(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        match self {
            Embedder::Bert(b) => b.embed_batch(texts),
            Embedder::Hashing(h) => Ok(texts.iter().map(|t| h.embed(t)).collect()),
        }
    }
}

/// BERT sentence-transformer (mean pooling + L2 normalization).
pub struct BertEngine {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
    device_name: String,
}

impl BertEngine {
    /// Load from a model folder holding `config.json`, `tokenizer.json` and
    /// `model.safetensors` (or `pytorch_model.bin`).
    pub fn load(dir: &Path, use_gpu: bool) -> Result<Self, String> {
        let device = get_device(use_gpu);
        let device_name = match &device {
            Device::Cpu => "CPU",
            Device::Cuda(_) => "CUDA",
            Device::Metal(_) => "Metal",
        }
        .to_string();

        let config: BertConfig = serde_json::from_slice(
            &std::fs::read(dir.join("config.json")).map_err(|e| format!("Failed to read config: {e}"))?,
        )
        .map_err(|e| format!("Failed to parse config: {e}"))?;
        let tokenizer =
            Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|e| format!("Failed to load tokenizer: {e}"))?;

        let safetensors = dir.join("model.safetensors");
        let vb = if safetensors.exists() {
            // SAFETY: the file is memory-mapped read-only and not modified while loaded
            // (downloads go to a `.part` file that is renamed into place).
            unsafe {
                VarBuilder::from_mmaped_safetensors(&[safetensors], DType::F32, &device)
                    .map_err(|e| format!("Failed to load safetensors: {e}"))?
            }
        } else {
            VarBuilder::from_pth(dir.join("pytorch_model.bin"), DType::F32, &device)
                .map_err(|e| format!("Failed to load pytorch weights: {e}"))?
        };
        let model = BertModel::load(vb, &config).map_err(|e| format!("Failed to create BERT model: {e}"))?;
        log::info!("model {} loaded on {device_name}", dir.display());
        Ok(Self { model, tokenizer, device, device_name })
    }

    fn embed_batch(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        if let Some((i, t)) = texts.iter().enumerate().find(|(_, t)| t.len() > 1_000_000) {
            return Err(format!("Text at index {i} is too long ({} chars, max 1M)", t.len()));
        }

        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| format!("Tokenization error: {e}"))?;

        let max_len = encodings.iter().map(|e| e.len()).max().unwrap_or(0).min(512);
        let batch_size = texts.len();
        let mut input_ids: Vec<u32> = Vec::with_capacity(batch_size * max_len);
        let mut attention_mask: Vec<u32> = Vec::with_capacity(batch_size * max_len);
        let mut token_type_ids: Vec<u32> = Vec::with_capacity(batch_size * max_len);
        for encoding in &encodings {
            let (ids, mask, types) = (encoding.get_ids(), encoding.get_attention_mask(), encoding.get_type_ids());
            for i in 0..max_len {
                if i < ids.len() {
                    input_ids.push(ids[i]);
                    attention_mask.push(mask[i]);
                    token_type_ids.push(types[i]);
                } else {
                    input_ids.push(0);
                    attention_mask.push(0);
                    token_type_ids.push(0);
                }
            }
        }

        fn e(what: &'static str) -> impl Fn(candle_core::Error) -> String {
            move |err| format!("{what}: {err}")
        }
        let input_ids = Tensor::from_vec(input_ids, (batch_size, max_len), &self.device).map_err(e("input_ids tensor"))?;
        let attention_mask =
            Tensor::from_vec(attention_mask, (batch_size, max_len), &self.device).map_err(e("attention_mask tensor"))?;
        let token_type_ids =
            Tensor::from_vec(token_type_ids, (batch_size, max_len), &self.device).map_err(e("token_type_ids tensor"))?;

        let hidden = self
            .model
            .forward(&input_ids, &token_type_ids, Some(&attention_mask))
            .map_err(e("Model forward pass failed"))?;

        // Mean pooling over the sequence with the attention mask, then L2 normalization.
        let mask = attention_mask.to_dtype(DType::F32).map_err(e("mask cast"))?.unsqueeze(2).map_err(e("mask unsqueeze"))?;
        let sum = hidden.broadcast_mul(&mask).map_err(e("mask apply"))?.sum(1).map_err(e("sum"))?;
        let count = mask.sum(1).map_err(e("mask sum"))?;
        let mean = sum.broadcast_div(&count).map_err(e("mean"))?;
        let norm = mean.sqr().map_err(e("sqr"))?.sum_keepdim(1).map_err(e("sum sq"))?.sqrt().map_err(e("sqrt"))?;
        let normalized = mean.broadcast_div(&norm).map_err(e("normalize"))?;
        normalized.to_vec2::<f32>().map_err(e("to_vec"))
    }
}

/// Feature hashing of lower-cased words and word bigrams into a fixed number
/// of dimensions (signed hashing, L2-normalized). Keyword-level similarity
/// only, but deterministic, instant and offline.
pub struct HashingEngine {
    dims: usize,
}

impl HashingEngine {
    pub fn new(dims: usize) -> Self {
        Self { dims }
    }

    fn fnv1a(s: &str) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in s.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }

    pub fn embed(&self, text: &str) -> Vec<f32> {
        let mut v = vec![0f32; self.dims];
        let words: Vec<String> = text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 1)
            .map(|w| w.to_lowercase())
            .collect();
        let mut add = |feature: &str, weight: f32| {
            let h = Self::fnv1a(feature);
            let idx = (h % self.dims as u64) as usize;
            let sign = if (h >> 63) == 0 { 1.0 } else { -1.0 };
            v[idx] += sign * weight;
        };
        for w in &words {
            add(w, 1.0);
        }
        for pair in words.windows(2) {
            add(&format!("{} {}", pair[0], pair[1]), 0.5);
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            v.iter_mut().for_each(|x| *x /= norm);
        }
        v
    }
}

/// Cosine similarity of two embeddings (0 for different lengths).
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a > 0.0 && norm_b > 0.0 {
        dot / (norm_a * norm_b)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_basics() {
        assert!((cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-4);
        assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-4);
        assert!((cosine_similarity(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-4);
        assert_eq!(cosine_similarity(&[1.0], &[1.0, 0.0]), 0.0);
    }

    #[test]
    fn hashing_ranks_keyword_overlap() {
        let h = HashingEngine::new(384);
        let q = h.embed("websocket reconnect backoff");
        let near = h.embed("We added exponential backoff to the websocket reconnect logic.");
        let far = h.embed("Updated the README with installation steps for Linux.");
        assert!(cosine_similarity(&q, &near) > cosine_similarity(&q, &far) + 0.2);
        assert_eq!(h.embed("same text"), h.embed("same text"));
    }
}
