//! Internal ABI. JS owns handles and passes only validated numeric snapshots.
use std::slice;

const MAX_ITEMS: usize = 100_000;

#[derive(Clone, Copy, Debug)]
struct Rect([f64; 4]);
impl Rect {
    fn valid(self) -> bool {
        self.0.iter().all(|v| v.is_finite()) && self.0[0] <= self.0[2] && self.0[1] <= self.0[3]
    }
    fn intersects(self, other: Self) -> bool {
        self.0[0] <= other.0[2]
            && self.0[2] >= other.0[0]
            && self.0[1] <= other.0[3]
            && self.0[3] >= other.0[1]
    }
    fn union(self, other: Self) -> Self {
        Self([
            self.0[0].min(other.0[0]),
            self.0[1].min(other.0[1]),
            self.0[2].max(other.0[2]),
            self.0[3].max(other.0[3]),
        ])
    }
}
struct Node {
    bounds: Rect,
    children: Option<(Box<Node>, Box<Node>)>,
    leaves: Vec<u32>,
}
impl Node {
    fn build(ids: &mut [u32], boxes: &[Rect]) -> Self {
        let bounds = ids
            .iter()
            .skip(1)
            .fold(boxes[ids[0] as usize], |b, id| b.union(boxes[*id as usize]));
        if ids.len() <= 8 {
            return Self {
                bounds,
                children: None,
                leaves: ids.to_vec(),
            };
        }
        let axis = usize::from(bounds.0[3] - bounds.0[1] > bounds.0[2] - bounds.0[0]);
        let middle = ids.len() / 2;
        // Halve before adding so large finite endpoints cannot overflow the sort key.
        ids.select_nth_unstable_by(middle, |a, b| {
            let center =
                |id: u32| boxes[id as usize].0[axis] / 2.0 + boxes[id as usize].0[axis + 2] / 2.0;
            center(*a).total_cmp(&center(*b)).then(a.cmp(b))
        });
        let (left, right) = ids.split_at_mut(middle);
        Self {
            bounds,
            children: Some((
                Box::new(Self::build(left, boxes)),
                Box::new(Self::build(right, boxes)),
            )),
            leaves: Vec::new(),
        }
    }
    fn query(&self, query: Rect, boxes: &[Rect], out: &mut Vec<u32>) {
        if !self.bounds.intersects(query) {
            return;
        }
        if let Some((left, right)) = &self.children {
            left.query(query, boxes, out);
            right.query(query, boxes, out);
        } else {
            out.extend(
                self.leaves
                    .iter()
                    .copied()
                    .filter(|id| boxes[*id as usize].intersects(query)),
            );
        }
    }
}
pub struct Index {
    boxes: Vec<Rect>,
    root: Option<Node>,
    results: Vec<u32>,
}
impl Index {
    fn new(boxes: Vec<Rect>) -> Self {
        let mut ids: Vec<u32> = (0..boxes.len() as u32).collect();
        let root = if ids.is_empty() {
            None
        } else {
            Some(Node::build(&mut ids, &boxes))
        };
        Self {
            boxes,
            root,
            results: Vec::new(),
        }
    }
    fn query(&mut self, query: Rect) {
        self.results.clear();
        if let Some(root) = &self.root {
            root.query(query, &self.boxes, &mut self.results);
        }
        self.results.sort_unstable(); // Preserve the domain's original order, not tree order.
    }
}

#[no_mangle]
pub extern "C" fn spatial_version() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn spatial_alloc(values: usize) -> *mut f64 {
    if values == 0 || values > MAX_ITEMS * 4 {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0.0; values].into_boxed_slice()) as *mut f64
}
/// Pointer/length must be the exact live allocation returned by spatial_alloc.
/// # Safety
/// The pointer must not be freed twice or used after this call.
#[no_mangle]
pub unsafe extern "C" fn spatial_free(ptr: *mut f64, values: usize) {
    if values > 0 && !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            ptr, values,
        )));
    }
}
/// Input remains caller-owned. The index takes its own immutable copy.
/// # Safety
/// ptr must address count * 4 initialized f64 values, or count must be zero.
#[no_mangle]
pub unsafe extern "C" fn spatial_build(ptr: *const f64, count: usize) -> *mut Index {
    if count > MAX_ITEMS || (count > 0 && ptr.is_null()) {
        return std::ptr::null_mut();
    }
    let input = if count == 0 {
        &[]
    } else {
        slice::from_raw_parts(ptr, count * 4)
    };
    let boxes: Vec<Rect> = input
        .chunks_exact(4)
        .map(|b| Rect([b[0], b[1], b[2], b[3]]))
        .collect();
    if boxes.iter().any(|b| !b.valid()) {
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(Index::new(boxes)))
}
#[no_mangle]
/// # Safety
/// index must be a live handle from spatial_build, with exclusive query access.
pub unsafe extern "C" fn spatial_query(
    index: *mut Index,
    x: f64,
    y: f64,
    right: f64,
    bottom: f64,
) -> i32 {
    let query = Rect([x, y, right, bottom]);
    if index.is_null() || !query.valid() {
        return -1;
    }
    (*index).query(query);
    (*index).results.len() as i32
}
#[no_mangle]
/// # Safety
/// index must be live. The result pointer expires on query or spatial_drop.
pub unsafe extern "C" fn spatial_results(index: *const Index) -> *const u32 {
    (*index).results.as_ptr()
}
#[no_mangle]
/// # Safety
/// index must be a live spatial_build handle and must be dropped exactly once.
pub unsafe extern "C" fn spatial_drop(index: *mut Index) {
    if !index.is_null() {
        drop(Box::from_raw(index));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tree_agrees_with_scan_including_edges_points_and_empty_data() {
        let boxes: Vec<Rect> = (0..200)
            .map(|i| Rect([i as f64 - 80.0, -10.0, i as f64 - 60.0, 20.0]))
            .collect();
        let mut tree = Index::new(boxes.clone());
        for x in -100..240 {
            let query = Rect([x as f64, 20.0, x as f64, 20.0]);
            tree.query(query);
            assert_eq!(
                tree.results,
                boxes
                    .iter()
                    .enumerate()
                    .filter(|(_, b)| b.intersects(query))
                    .map(|(i, _)| i as u32)
                    .collect::<Vec<_>>()
            );
        }
        let mut empty = Index::new(Vec::new());
        empty.query(Rect([0.0; 4]));
        assert!(empty.results.is_empty());
    }
}
