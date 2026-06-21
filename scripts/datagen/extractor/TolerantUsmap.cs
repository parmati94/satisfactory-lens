using CUE4Parse.Compression;
using CUE4Parse.MappingsProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Objects.Core.Serialization;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;

namespace SatisfactoryLens.Extractor;

// A usmap mappings provider tolerant of Coffee Stain's official
// CommunityResources/FactoryGame.usmap, which encodes OptionalProperty WITHOUT an
// inner type. Stock CUE4Parse (every version) reads an inner type for
// OptionalProperty and desyncs → crash. This is a faithful copy of CUE4Parse's
// UsmapParser with that ONE difference: OptionalProperty is parsed as a leaf.
//
// Verified: parses all 57,917 names / 2,594 enums / 13,795 structs of the shipped
// usmap. The 44 OptionalProperty occurrences get no inner type — harmless unless an
// extracted asset actually serializes one (none of the data we pull does).
internal sealed class TolerantFileUsmapProvider : AbstractTypeMappingsProvider
{
    private const ushort FileMagic = 0x30C4;
    private readonly string _path;

    public override TypeMappings? MappingsForGame { get; protected set; }

    public TolerantFileUsmapProvider(string path)
    {
        _path = path;
        Load(path);
    }

    public override void Load(string path) => MappingsForGame = Parse(File.ReadAllBytes(path));
    public override void Load(byte[] bytes) => MappingsForGame = Parse(bytes);
    public override void Reload() => Load(_path);

    private static TypeMappings Parse(byte[] fileBytes)
    {
        var archive = new FByteArchive("FactoryGame.usmap", fileBytes);

        var magic = archive.Read<ushort>();
        if (magic != FileMagic) throw new InvalidDataException("usmap: bad magic");

        var version = archive.Read<EUsmapVersion>();
        if (version > EUsmapVersion.Latest) throw new InvalidDataException($"usmap: unsupported version {(byte)version}");

        var Ar = new FUsmapReader(archive, version);

        // Package-versioning header block (present on this usmap).
        if (Ar.Version >= EUsmapVersion.PackageVersioning && Ar.ReadBoolean())
        {
            _ = Ar.Read<FPackageFileVersion>();
            _ = new FCustomVersionContainer(Ar);
            _ = Ar.Read<uint>(); // NetCL
        }

        var compMethod = Ar.Read<EUsmapCompressionMethod>();
        var compSize = Ar.Read<uint>();
        var decompSize = Ar.Read<uint>();

        var data = new byte[decompSize];
        switch (compMethod)
        {
            case EUsmapCompressionMethod.None:
                if (compSize != decompSize) throw new InvalidDataException("usmap: None comp size mismatch");
                _ = Ar.Read(data, 0, (int)compSize);
                break;
            case EUsmapCompressionMethod.Oodle:
                OodleHelper.Decompress(Ar.ReadBytes((int)compSize), 0, (int)compSize, data, 0, (int)decompSize);
                break;
            default:
                throw new NotSupportedException($"usmap: compression {compMethod} not handled (extend if a future usmap needs it)");
        }

        Ar = new FUsmapReader(new FByteArchive("usmap-body", data), version);

        // Name table.
        var nameSize = Ar.Read<uint>();
        var nameLut = new List<string>((int)nameSize);
        for (var i = 0; i < nameSize; i++)
        {
            var len = version >= EUsmapVersion.LongFName ? Ar.Read<ushort>() : Ar.Read<byte>();
            nameLut.Add(Ar.ReadStringUnsafe(len));
        }

        // Enums.
        var enumCount = Ar.Read<uint>();
        var enums = new Dictionary<string, Dictionary<int, string>>((int)enumCount);
        for (var i = 0; i < enumCount; i++)
        {
            var enumName = Ar.ReadName(nameLut)!;
            var sz = version >= EUsmapVersion.LargeEnums ? Ar.Read<ushort>() : Ar.Read<byte>();
            var entries = new Dictionary<int, string>(sz);
            if (version >= EUsmapVersion.ExplicitEnumValues)
                for (var j = 0; j < sz; j++) { var v = Ar.Read<ulong>(); entries[(int)v] = Ar.ReadName(nameLut)!; }
            else
                for (var j = 0; j < sz; j++) entries[j] = Ar.ReadName(nameLut)!;
            enums.TryAdd(enumName, entries);
        }

        // Structs.
        var structCount = Ar.Read<uint>();
        var structs = new Dictionary<string, Struct>(StringComparer.OrdinalIgnoreCase);
        var mappings = new TypeMappings(structs, enums);
        for (var i = 0; i < structCount; i++)
        {
            var s = ParseStruct(mappings, Ar, nameLut);
            structs[s.Name] = s;
        }
        return mappings;
    }

    private static Struct ParseStruct(TypeMappings ctx, FUsmapReader Ar, IReadOnlyList<string> nameLut)
    {
        var name = Ar.ReadName(nameLut)!;
        var superType = Ar.ReadName(nameLut);
        var propertyCount = Ar.Read<ushort>();
        var serializablePropertyCount = Ar.Read<ushort>();
        var properties = new Dictionary<int, PropertyInfo>();
        for (var i = 0; i < serializablePropertyCount; i++)
        {
            var index = Ar.Read<ushort>();
            var arrayDim = Ar.Read<byte>();
            var propName = Ar.ReadName(nameLut)!;
            var type = ParseType(Ar, nameLut);
            var info = new PropertyInfo(index, propName, type, arrayDim);
            for (var j = 0; j < arrayDim; j++)
            {
                var clone = (PropertyInfo)info.Clone();
                clone.Index = j;
                properties[index + j] = clone;
            }
        }
        return new Struct(ctx, name, superType, properties, propertyCount);
    }

    private static PropertyType ParseType(FUsmapReader Ar, IReadOnlyList<string> nameLut)
    {
        var typeEnum = Ar.Read<EPropertyType>();
        var type = Enum.GetName(typeEnum) ?? string.Empty;
        string? structType = null, enumName = null;
        PropertyType? inner = null, value = null;
        switch (typeEnum)
        {
            case EPropertyType.EnumProperty: inner = ParseType(Ar, nameLut); enumName = Ar.ReadName(nameLut); break;
            case EPropertyType.StructProperty: structType = Ar.ReadName(nameLut); break;
            case EPropertyType.SetProperty:
            case EPropertyType.ArrayProperty: inner = ParseType(Ar, nameLut); break;
            case EPropertyType.OptionalProperty: break; // CSS usmap: no inner type (the whole point of this provider)
            case EPropertyType.MapProperty: inner = ParseType(Ar, nameLut); value = ParseType(Ar, nameLut); break;
        }
        return new PropertyType(type, structType, inner, value, enumName);
    }
}
