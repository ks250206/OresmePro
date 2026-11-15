/**
 * Formats that Python reads, with packages of the Pyodide distribution
 * (pyarrow, h5py), rather than the app itself: Parquet and HDF5.
 */
const LOADERS: readonly [RegExp, string][] = [
  [/\.parquet$/i, "load_parquet"],
  [/\.(h5|hdf5)$/i, "load_hdf5"],
];

/** The file types to offer when asking for files that Python reads. */
export const PYTHON_FORMATS = ".parquet,.h5,.hdf5";

/**
 * The Python that loads a file of the experiment's files, by its extension;
 * null if Python has no loader for it.
 */
export function pythonLoader(path: string): string | null {
  const loader = LOADERS.find(([pattern]) => pattern.test(path));
  return loader ? `op.${loader[1]}(${JSON.stringify(path)})` : null;
}
