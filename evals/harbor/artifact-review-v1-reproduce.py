import json
from decimal import Decimal
import pandas as pd
import pyarrow as pa
import narwhals as nw

results = {
    "versions": {"pandas": pd.__version__, "pyarrow": pa.__version__},
    "pandas_grouped": {},
    "arrow_quantile": {},
}
df = nw.from_native(
    pd.DataFrame(
        {"a": [1.0, 3.0, 10.0, 20.0], "g": ["x", "x", "y", "y"], "i": [0, 1, 2, 3]}
    )
)
for method in (
    "rolling_sum",
    "rolling_mean",
    "rolling_min",
    "rolling_max",
    "rolling_median",
    "rolling_quantile",
):
    try:
        expr = getattr(nw.col("a"), method)(
            2,
            min_samples=1,
            **({"quantile": 0.5} if method == "rolling_quantile" else {}),
        ).over("g", order_by="i")
        results["pandas_grouped"][method] = {"values": df.select(expr)["a"].to_list()}
    except Exception as e:
        results["pandas_grouped"][method] = {
            "error_type": type(e).__name__,
            "message": str(e),
        }
for label, array in [
    ("large_int", pa.chunked_array([[2**53 + 1, 2**53 + 3]])),
    (
        "decimal",
        pa.chunked_array(
            [[Decimal("1.00"), Decimal("2.00")]], type=pa.decimal128(10, 2)
        ),
    ),
]:
    s = nw.from_native(array, series_only=True)
    row = {}
    for interpolation in ("linear", "lower", "higher", "nearest", "midpoint"):
        entry = {}
        for mode in ("existing_quantile", "new_rolling_quantile"):
            try:
                value = (
                    s.quantile(0.5, interpolation=interpolation)
                    if mode == "existing_quantile"
                    else s.rolling_quantile(
                        2, quantile=0.5, interpolation=interpolation
                    ).to_list()
                )
                entry[mode] = {"value": value}
            except Exception as e:
                entry[mode] = {"error_type": type(e).__name__, "message": str(e)}
        row[interpolation] = entry
    results["arrow_quantile"][label] = row
print(json.dumps(results, indent=2, default=str))
assert results["pandas_grouped"]["rolling_sum"]["values"] == [1.0, 4.0, 10.0, 30.0]
assert results["pandas_grouped"]["rolling_mean"]["values"] == [1.0, 2.0, 10.0, 15.0]
for method in ("rolling_min", "rolling_max", "rolling_median", "rolling_quantile"):
    assert results["pandas_grouped"][method]["error_type"] == "NotImplementedError"
for label in ("large_int", "decimal"):
    for interpolation in ("lower", "higher", "nearest"):
        row = results["arrow_quantile"][label][interpolation]
        assert "error_type" not in row["existing_quantile"]
        assert row["new_rolling_quantile"]["error_type"] == "ArrowInvalid"
    for interpolation in ("linear", "midpoint"):
        assert (
            "error_type"
            not in results["arrow_quantile"][label][interpolation][
                "new_rolling_quantile"
            ]
        )
