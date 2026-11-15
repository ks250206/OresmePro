from oresme_plugin import action, wave


@action("scale")
def scale(y, factor=2.0):
    print(f"scaling {y.name} by {factor}")
    return {
        "waves": {"scaled": wave(y.data * factor, like=y)},
        "values": {
            "result": {"names": ["factor"], "coef": [factor], "sigma": [0.0], "points": len(y)},
        },
    }
