"""Reference reader for a UE5.1 FMeshDescription payload, verified byte-exact on Common Hazel.

Input: one decompressed FEditorBulkData payload from an uncooked UE5 StaticMesh package's trailer
(decompress with ThreeNativeConverter's DecompressEditorPayload). This is the spec the C# port in
ue5-editor-static-meshes.md follows; it is not called by the importer.

    python3 ue5-mesh-description-reference.py payload.bin
"""
import struct
import sys

FNAME = 6   # values are FStrings, with no element-size field
# Default-value size per attribute type: FVector4f, FVector3f, FVector2f, float, int32, and bool
# (a 4-byte UE bool, although bulk arrays store 1 byte per element). The default is written even
# for an attribute with no channels, so it cannot be sized from the arrays.
DEFAULT_SIZE = {0: 16, 1: 12, 2: 8, 3: 4, 4: 4, 5: 4}


class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def i32(self):
        value = struct.unpack_from("<i", self.data, self.pos)[0]
        self.pos += 4
        return value

    def fstring(self):  # int32 length including NUL, then ASCII
        length = self.i32()
        value = self.data[self.pos:self.pos + length - 1].decode()
        self.pos += length
        return value

    def raw(self, size):
        value = self.data[self.pos:self.pos + size]
        self.pos += size
        return value


def parse(data):
    """{element: [channel]}, where channel = {"count": n, "attributes": {name: [array per index]}}."""
    r, elements = Reader(data), {}
    for _ in range(r.i32()):                        # element types: Vertices, VertexInstances, UVs, ...
        element, channels = r.fstring(), []
        for _ in range(r.i32()):                    # channels (UVs has one per UV set)
            bits = r.i32()
            r.raw(4 * ((bits + 31) // 32))          # allocation bit array: 1 = live element
            r.i32()                                 # free-list head (0 when compact)
            count = r.i32()
            attributes = {}
            for _ in range(r.i32()):
                name = r.fstring()                  # note: Vertex position is "Position " (trailing space)
                kind = r.i32()
                r.i32()                             # unknown, 1 or 2 so far
                r.i32()                             # element count again
                arrays = []
                for _ in range(r.i32()):            # attribute indices (TextureCoordinate has one per UV set)
                    r.i32()                         # extent: values per element (3 for triangle corners)
                    if kind == FNAME:
                        arrays.append([r.fstring() for _ in range(r.i32())])
                        continue
                    size, n = r.i32(), r.i32()
                    arrays.append(r.raw(size * n))
                if kind == FNAME:
                    r.fstring()                     # default value
                else:
                    r.raw(DEFAULT_SIZE[kind])
                r.i32()                             # EMeshAttributeFlags (Mandatory=32, IndexReference=16, ...)
                attributes[name] = arrays
            channels.append({"count": count, "attributes": attributes})
        elements[element] = channels
    if r.pos != len(data):
        raise ValueError(f"consumed {r.pos} of {len(data)} bytes")
    return elements


if __name__ == "__main__":
    mesh = parse(open(sys.argv[1], "rb").read())
    for element, channels in mesh.items():
        for index, channel in enumerate(channels):
            print(f"{element}[{index}] x{channel['count']}: {', '.join(channel['attributes'])}")
