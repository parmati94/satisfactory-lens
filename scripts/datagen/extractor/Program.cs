using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Versions;
using CUE4Parse.Compression;
using Newtonsoft.Json;

namespace SatisfactoryLens.Extractor;

internal static class Program
{
    private static string DataRoot =>
        Environment.GetEnvironmentVariable("SATISFACTORY_PAK_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        ".gamedata", "satisfactory-pak-data");

    private static string InputDir => Path.Combine(DataRoot, "input");
    private static string Usmap => Path.Combine(InputDir, "FactoryGame.usmap");
    private static string OodlePath => Path.Combine(AppContext.BaseDirectory, "runtime", "liboodle-data-shared.so");

    // Default output tree — mirrors the FModel-extracted layout but lives in its OWN
    // dir so we never overwrite the manual FactoryGame/ extraction.
    private static string OutRoot =>
        Environment.GetEnvironmentVariable("SATISFACTORY_EXTRACT_DIR")
        ?? Path.Combine(DataRoot, "extracted");

    private static readonly EGame Game = EGame.GAME_UE5_6;

    private static int Main(string[] args)
    {
        var cmd = args.Length > 0 ? args[0] : "smoke";
        var provider = Setup();
        Console.WriteLine($"mounted {provider.Files.Count} files; command='{cmd}'");

        switch (cmd)
        {
            case "smoke":
                return Smoke(provider);
            case "json-one":
                return JsonOne(provider, args[1]);
            case "json-tree":
                return JsonTree(provider, args[1], args.Length > 2 ? args[2].Split(',') : null);
            case "raw":
                return Raw(provider, args[1], args.Length > 2 ? args[2].Split(',') : null);
            case "mesh":
                return Mesh(provider, args[1], args.Length > 2 ? args[2].Split(',') : null);
            default:
                Console.Error.WriteLine($"unknown command: {cmd}");
                return 2;
        }
    }

    private static DefaultFileProvider Setup()
    {
        OodleHelper.Initialize(OodlePath);
        var provider = new DefaultFileProvider(
            InputDir, SearchOption.TopDirectoryOnly, isCaseInsensitive: true, new VersionContainer(Game));
        // Tolerant provider for Coffee Stain's leaf-OptionalProperty usmap (see TolerantUsmap.cs).
        provider.MappingsContainer = new TolerantFileUsmapProvider(Usmap);
        provider.Initialize();
        provider.SubmitKey(new FGuid(), new FAesKey(new byte[32]));
        return provider;
    }

    private static int Smoke(DefaultFileProvider provider)
    {
        var key = provider.Files.Keys.FirstOrDefault(k => k.Contains("/Desc_IronPlate.", StringComparison.OrdinalIgnoreCase));
        if (key == null) { Console.Error.WriteLine("Desc_IronPlate not found"); return 1; }
        var pkg = provider.LoadPackage(key);
        foreach (var e in pkg.GetExports().Where(e => e.Properties.Count > 0))
            Console.WriteLine($"  {e.Name} ({e.ExportType}): {string.Join(", ", e.Properties.Select(p => p.Name.Text))}");
        return 0;
    }

    // Serialize one package's exports to FModel-style JSON and print it (format check).
    private static int JsonOne(DefaultFileProvider provider, string mountKey)
    {
        var pkg = provider.LoadPackage(mountKey);
        var json = JsonConvert.SerializeObject(pkg.GetExports(), Formatting.Indented);
        Console.WriteLine(json);
        return 0;
    }

    // Copy raw file bytes (uasset/ubulk/uexp/…) under a mount prefix to <OutRoot>/<key>,
    // preserving the original bytes so convert_icons.py / the heightmap parser work
    // unchanged. Writes ONLY under OutRoot.
    private static int Raw(DefaultFileProvider provider, string mountPrefix, string[]? namePrefixes)
    {
        var keys = provider.Files.Keys
            .Where(k => k.StartsWith(mountPrefix, StringComparison.OrdinalIgnoreCase)
                        && (namePrefixes == null || namePrefixes.Any(p =>
                              Path.GetFileName(k).StartsWith(p, StringComparison.OrdinalIgnoreCase))))
            .ToList();
        Console.WriteLine($"copying {keys.Count} raw files under '{mountPrefix}' → {OutRoot}");

        int ok = 0, fail = 0;
        foreach (var key in keys)
        {
            try
            {
                var bytes = provider.SaveAsset(key);
                var outPath = Path.Combine(OutRoot, key);
                Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
                File.WriteAllBytes(outPath, bytes);
                if (++ok % 500 == 0) Console.WriteLine($"  ...{ok}");
            }
            catch (Exception ex)
            {
                fail++;
                if (fail <= 10) Console.Error.WriteLine($"  FAIL {key}: {ex.Message}");
            }
        }
        Console.WriteLine($"done: {ok} copied, {fail} failed");
        return 0;
    }

    // Export StaticMeshes under a mount prefix to binary glTF (.glb) — the render-mesh
    // input generate_building_footprints reads (FModel "Save Model"). Same CUE4Parse
    // conversion FModel uses, so vertices match. Writes ONLY under OutRoot.
    private static int Mesh(DefaultFileProvider provider, string mountPrefix, string[]? namePrefixes)
    {
        var options = new CUE4Parse_Conversion.ExporterOptions
        {
            LodFormat = CUE4Parse_Conversion.Meshes.ELodFormat.FirstLod,
            MeshFormat = CUE4Parse_Conversion.Meshes.EMeshFormat.Gltf2,
            ExportMaterials = false,
        };

        var keys = provider.Files.Keys
            .Where(k => k.StartsWith(mountPrefix, StringComparison.OrdinalIgnoreCase) && k.EndsWith(".uasset")
                        && (namePrefixes == null || namePrefixes.Any(p =>
                              Path.GetFileName(k).StartsWith(p, StringComparison.OrdinalIgnoreCase))))
            .ToList();
        Console.WriteLine($"exporting meshes under '{mountPrefix}' ({keys.Count} packages) → {OutRoot}");

        int ok = 0, fail = 0, nomesh = 0;
        foreach (var key in keys)
        {
            try
            {
                var pkg = provider.LoadPackage(key);
                var sm = pkg.GetExports().OfType<CUE4Parse.UE4.Assets.Exports.StaticMesh.UStaticMesh>().FirstOrDefault();
                if (sm == null) { nomesh++; continue; }
                var exporter = new CUE4Parse_Conversion.Meshes.MeshExporter(sm, options);
                // TryWriteToDir appends the package's full mount path under the base dir,
                // so pass OutRoot directly → <OutRoot>/FactoryGame/Content/.../SM_X.glb.
                Directory.CreateDirectory(OutRoot);
                if (exporter.TryWriteToDir(new DirectoryInfo(OutRoot), out _, out _)) ok++; else fail++;
            }
            catch (Exception ex)
            {
                fail++;
                if (fail <= 10) Console.Error.WriteLine($"  FAIL {key}: {ex.Message}");
            }
        }
        Console.WriteLine($"done: {ok} meshes exported, {nomesh} non-mesh skipped, {fail} failed");
        return 0;
    }

    // Export every package under a mount prefix to <OutRoot>/<key>.json (matching the
    // FModel tree layout the Python generators read). Writes ONLY under OutRoot.
    private static int JsonTree(DefaultFileProvider provider, string mountPrefix, string[]? namePrefixes)
    {
        var keys = provider.Files.Keys
            .Where(k => k.StartsWith(mountPrefix, StringComparison.OrdinalIgnoreCase)
                        && (k.EndsWith(".uasset") || k.EndsWith(".umap"))
                        && (namePrefixes == null || namePrefixes.Any(p =>
                              Path.GetFileName(k).StartsWith(p, StringComparison.OrdinalIgnoreCase))))
            .ToList();
        Console.WriteLine($"exporting {keys.Count} packages under '{mountPrefix}' → {OutRoot}");

        int ok = 0, fail = 0;
        foreach (var key in keys)
        {
            try
            {
                var pkg = provider.LoadPackage(key);
                var json = JsonConvert.SerializeObject(pkg.GetExports(), Formatting.Indented);
                var rel = Path.ChangeExtension(key, ".json");
                var outPath = Path.Combine(OutRoot, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
                File.WriteAllText(outPath, json);
                if (++ok % 500 == 0) Console.WriteLine($"  ...{ok}");
            }
            catch (Exception ex)
            {
                fail++;
                if (fail <= 10) Console.Error.WriteLine($"  FAIL {key}: {ex.Message}");
            }
        }
        Console.WriteLine($"done: {ok} written, {fail} failed");
        return 0;
    }
}
