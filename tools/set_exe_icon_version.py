"""Replace the exe's icon images in place (same slots) and set the version-info strings."""
import pefile, struct, io, sys
from PIL import Image
exe, src_png, out, VERSION = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
pe = pefile.PE(exe)
data = bytearray(pe.__data__)
master = Image.open(src_png).convert('RGBA')
res = {t.id: t for t in pe.DIRECTORY_ENTRY_RESOURCE.entries}
icons = {e.id: e.directory.entries[0].data.struct for e in res[3].directory.entries}
grp = res[14].directory.entries[0].directory.entries[0].data.struct
g_off = pe.get_offset_from_rva(grp.OffsetToData)
_, _, count = struct.unpack_from('<HHH', data, g_off)
for i in range(count):
    eo = g_off + 6 + i * 14
    w, h, cc, _, planes, bpp, size, iid = struct.unpack_from('<BBBBHHIH', data, eo)
    W, H = w or 256, h or 256
    img = master.resize((W, H), Image.LANCZOS)
    if W >= 256:
        b = io.BytesIO(); img.save(b, 'PNG', optimize=True); blob = b.getvalue()
    else:  # 32-bit BMP icon entry: BITMAPINFOHEADER + BGRA bottom-up + AND mask
        hdr = struct.pack('<IiiHHIIiiII', 40, W, H * 2, 1, 32, 0, 0, 0, 0, 0, 0)
        px = img.transpose(Image.FLIP_TOP_BOTTOM).tobytes('raw', 'BGRA')
        mask = bytes(((W + 31) // 32) * 4 * H)
        blob = hdr + px + mask
    st = icons[iid]
    if len(blob) > st.Size:
        if W >= 256:  # try harder compression via fewer colours
            q = img.quantize(256).convert('RGBA'); b = io.BytesIO(); q.save(b, 'PNG', optimize=True); blob = b.getvalue()
        assert len(blob) <= st.Size, (W, len(blob), st.Size)
    off = pe.get_offset_from_rva(st.OffsetToData)
    data[off:off + st.Size] = blob + bytes(st.Size - len(blob))
    struct.pack_into('<BBBBHHIH', data, eo, w, h, 0, 0, 1, 32, len(blob), iid)
    # shrink the declared size so Windows reads exactly our image
    st_off = st.get_file_offset()
    struct.pack_into('<I', data, st_off + 4, len(blob))
    print('icon', W, 'x', H, len(blob), '/', st.Size)
# rebuild the version-info resource in its existing slot (shown in Task Manager / file Properties)
def node(key, value=b'', vtype=1, children=b'', vlen=None):
    k = (key + '\0').encode('utf-16-le')
    body = struct.pack('<HHH', 0, 0, 0) + k
    body += bytes((-len(body)) % 4) + value
    body += bytes((-len(body)) % 4) + children
    if vlen is None: vlen = len(value) // 2 if vtype == 1 else len(value)
    return struct.pack('<HHH', len(body), vlen, vtype) + body[6:]
def pad4(b): return b + bytes((-len(b)) % 4)
def string(k, v): return pad4(node(k, (v + '\0').encode('utf-16-le')))
ver = [int(x) for x in VERSION.split('.')] + [0]
strings = b''.join(string(k, v) for k, v in [('CompanyName', 'Mike'), ('FileDescription', "Mike's PDF Studio"), ('FileVersion', VERSION),
    ('InternalName', 'PDFStudio'), ('OriginalFilename', "Mike's PDF Studio.exe"), ('ProductName', "Mike's PDF Studio"), ('ProductVersion', VERSION)])
table = pad4(node('040904B0', children=strings, vlen=0))
sfi = pad4(node('StringFileInfo', children=table, vlen=0))
var = pad4(node('Translation', struct.pack('<HH', 0x0409, 1200), vtype=0))
vfi = pad4(node('VarFileInfo', children=var, vlen=0))
fixed = struct.pack('<13I', 0xFEEF04BD, 0x10000, (ver[0] << 16) | ver[1], (ver[2] << 16) | ver[3], (ver[0] << 16) | ver[1], (ver[2] << 16) | ver[3], 0x3F, 0, 0x40004, 1, 0, 0, 0)
vs = node('VS_VERSION_INFO', fixed, vtype=0, children=sfi + vfi)
vst = res[16].directory.entries[0].directory.entries[0].data.struct
assert len(vs) <= vst.Size, (len(vs), vst.Size)
voff = pe.get_offset_from_rva(vst.OffsetToData)
data[voff:voff + vst.Size] = vs + bytes(vst.Size - len(vs))
struct.pack_into('<I', data, vst.get_file_offset() + 4, len(vs))
print('version info', len(vs), '/', vst.Size)
open(out, 'wb').write(data)
