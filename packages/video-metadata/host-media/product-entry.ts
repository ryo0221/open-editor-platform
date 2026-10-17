// Same import/edit/save/open Host; reviewed codec units are assembled here only.
import { installProductCodec } from './browser-host';
// @ts-expect-error Fixed external codec dependencies remain outside the root manifest.
import { productCodec } from './product-codec.mjs';
installProductCodec(productCodec);
