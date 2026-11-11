// fem-mesher: Netgen volume meshing of a closed, tagged surface triangulation (R3b).
#include <meshing.hpp>
#include <emscripten/emscripten.h>
#include <vector>
#include <string>

namespace netgen { extern MeshingParameters mparam; }
using namespace netgen;

static std::vector<double> outPoints;
static std::vector<int> outTets, outTris, outTriFace;
static std::string lastError;

extern "C" {
// Returns 0 on success, 1 on a Netgen failure (message in fm_error), 2 when no tetrahedron came out.
EMSCRIPTEN_KEEPALIVE int fm_mesh(int np, const double* p, int nt, const int* t, const int* tf,
                                 int nfaces, double maxh, double minh, double grading,
                                 int optsteps) {
  outPoints.clear(); outTets.clear(); outTris.clear(); outTriFace.clear(); lastError.clear();
  try {
    auto mesh = std::make_shared<Mesh>();
    std::vector<PointIndex> ids(np);
    for (int i = 0; i < np; i++) ids[i] = mesh->AddPoint(Point3d(p[3*i], p[3*i+1], p[3*i+2]));
    for (int f = 0; f < nfaces; f++) mesh->AddFaceDescriptor(FaceDescriptor(f + 1, 1, 0, 0));
    for (int k = 0; k < nt; k++) {
      Element2d el(3);
      el.SetIndex(tf[k] + 1);
      for (int j = 0; j < 3; j++) el[j] = ids[t[3*k+j]];
      mesh->AddSurfaceElement(el);
    }
    mparam = MeshingParameters();
    mparam.maxh = maxh; mparam.minh = minh; mparam.grading = grading;
    mparam.optsteps3d = optsteps;
    mesh->CalcLocalH(mparam.grading);
    MeshVolume(mparam, *mesh);
    RemoveIllegalElements(*mesh);
    OptimizeVolume(mparam, *mesh);
    for (PointIndex pi = PointIndex::BASE; pi < mesh->GetNP() + PointIndex::BASE; pi++) {
      const auto& q = (*mesh)[pi];
      outPoints.push_back(q(0)); outPoints.push_back(q(1)); outPoints.push_back(q(2));
    }
    for (auto& el : mesh->VolumeElements()) {
      if (el.GetNP() != 4) { lastError = "non-tet element"; return 1; }
      for (int j = 0; j < 4; j++) outTets.push_back(int(el[j]) - int(PointIndex::BASE));
    }
    for (auto& el : mesh->SurfaceElements()) {
      for (int j = 0; j < 3; j++) outTris.push_back(int(el[j]) - int(PointIndex::BASE));
      outTriFace.push_back(mesh->GetFaceDescriptor(el.GetIndex()).SurfNr() - 1);
    }
    return outTets.empty() ? 2 : 0;
  } catch (const std::exception& e) {
    lastError = e.what();
    return 1;
  } catch (...) {
    lastError = "unknown";
    return 1;
  }
}
EMSCRIPTEN_KEEPALIVE int fm_points() { return int(outPoints.size() / 3); }
EMSCRIPTEN_KEEPALIVE const double* fm_point_data() { return outPoints.data(); }
EMSCRIPTEN_KEEPALIVE int fm_tets() { return int(outTets.size() / 4); }
EMSCRIPTEN_KEEPALIVE const int* fm_tet_data() { return outTets.data(); }
EMSCRIPTEN_KEEPALIVE int fm_tris() { return int(outTriFace.size()); }
EMSCRIPTEN_KEEPALIVE const int* fm_tri_data() { return outTris.data(); }
EMSCRIPTEN_KEEPALIVE const int* fm_tri_face() { return outTriFace.data(); }
EMSCRIPTEN_KEEPALIVE const char* fm_error() { return lastError.c_str(); }
}
