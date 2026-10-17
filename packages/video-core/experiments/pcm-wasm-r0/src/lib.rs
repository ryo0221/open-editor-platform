//! Private, scalar, single-owner ABI. No allocation, imports, or pointer parameters.
#![no_std]
use core::{cell::UnsafeCell, panic::PanicInfo};
const FRAMES: usize = 32768;
const ROWS: usize = 64;
const TAPS: usize = 513;
#[repr(C)]
struct Arena {
    source: [f32; FRAMES * 2],
    weights: [f64; ROWS * TAPS],
    addresses: [u32; ROWS * TAPS],
    totals: [f64; ROWS],
    lengths: [u32; ROWS],
    output: [f32; ROWS * 2],
}
struct Owned(UnsafeCell<Arena>);
// Module has no threads, shared memory, callbacks or imports. Each instance has one owner.
unsafe impl Sync for Owned {}
static ARENA: Owned = Owned(UnsafeCell::new(Arena {
    source: [0.0; FRAMES * 2], weights: [0.0; ROWS * TAPS],
    addresses: [0; ROWS * TAPS], totals: [0.0; ROWS],
    lengths: [0; ROWS], output: [0.0; ROWS * 2],
}));
static mut WRITTEN: u32 = 0;
#[panic_handler]
fn panic(_: &PanicInfo) -> ! { core::arch::wasm32::unreachable() }
#[no_mangle]
pub extern "C" fn abi() -> u32 { 1 }
#[no_mangle]
pub extern "C" fn arena() -> u32 { ARENA.0.get() as u32 }
#[no_mangle]
pub extern "C" fn arena_bytes() -> u32 { core::mem::size_of::<Arena>() as u32 }
#[no_mangle]
pub extern "C" fn written() -> u32 { unsafe { WRITTEN } }
/// Status 0 success, 1 shape, 2 row/total/weight, 3 address, 4 nonfinite PCM.
/// Failure always exposes initialized length zero. Callers must ignore stale arena output.
#[no_mangle]
pub extern "C" fn kernel(rows: u32, frames: u32, channels: u32) -> u32 {
    unsafe { WRITTEN = 0; }
    if rows == 0 || rows > ROWS as u32 || frames == 0 || frames > FRAMES as u32
        || channels == 0 || channels > 2 { return 1; }
    let a = unsafe { &mut *ARENA.0.get() };
    // Validate the entire job before touching output. Bounds are fixed, offsets are not supplied.
    for row in 0..rows as usize {
        let n = a.lengths[row] as usize;
        if n == 0 || n > TAPS || !a.totals[row].is_finite()
            || a.totals[row].abs() <= 1e-9 { return 2; }
        for tap in 0..n {
            let i = row * TAPS + tap;
            if !a.weights[i].is_finite() { return 2; }
            let at = a.addresses[i] as usize;
            if at >= frames as usize { return 3; }
            for ch in 0..channels as usize {
                if !a.source[ch * FRAMES + at].is_finite() { return 4; }
            }
        }
    }
    for row in 0..rows as usize {
        for ch in 0..channels as usize {
            let mut sum = 0.0_f64;
            for tap in 0..a.lengths[row] as usize {
                let i = row * TAPS + tap;
                // Separate scalar operations; no mul_add, SIMD, reassociation or fast math.
                let product = a.source[ch * FRAMES + a.addresses[i] as usize] as f64 * a.weights[i];
                sum += product;
            }
            // Deliberately retain IEEE f32 overflow and signed zero. Product guards are external.
            a.output[ch * ROWS + row] = (sum / a.totals[row]) as f32;
        }
    }
    unsafe { WRITTEN = rows * channels; }
    0
}
