<?php

namespace Test\Foo\Model;

class FooService
{
    public function __construct(
        private FooFactory $fooFactory,
    ) {
    }

    public function createAndSave(): void
    {
        $foo = $this->fooFactory->create();
        $foo->save();
    }
}
